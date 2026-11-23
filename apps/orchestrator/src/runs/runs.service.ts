import { Inject, Injectable } from '@nestjs/common';
import { clip, MAX_REASON_CHARS, type IssueEvent, type JobPayload } from '@page/contracts';
import type { Insertable, Transaction } from 'kysely';
import type { Database, Db, RunsTable } from '../db/database.ts';
import { IssuesService, type Moved } from '../issues/issues.service.ts';
import { issueLogger, type Logger } from '../logger.ts';
import type { FixJob } from '../queue/fix-jobs.ts';
import type { JobQueues } from '../queue/queues.ts';
import { DB, JOB_QUEUES, LOGGER } from '../tokens.ts';

export type RunFinishedJob = JobPayload<'run_finished'>;
type RunResult = RunFinishedJob['result'];

const reason = (text: string) => clip(text, MAX_REASON_CHARS);

/**
 * The issue event a run's result applies. A success is a patch for review, unless the run
 * fixed the live app through the ops API and left no code change: that fix is live already,
 * so the issue resolves. An escalation moves up a tier (or to `failed` past Tier 3) and hands
 * its note to the next run. A failure goes straight to `failed`: the daemon only fails a run
 * a higher tier can't fix. A killed run kills the issue.
 */
export function issueEventFor(result: RunResult): IssueEvent {
  const { runId } = result;
  switch (result.status) {
    case 'succeeded':
      return result.opsOnly ? { type: 'ops_fixed', runId } : { type: 'patch_ready', runId };
    case 'escalated':
      return {
        type: 'escalate',
        runId,
        reason: reason(`${result.reason}: ${result.note.summary}`),
      };
    case 'failed': {
      const why = result.note ? `${result.note.summary} ${result.note.blocker}` : 'The run failed.';
      return { type: 'fail', runId, reason: reason(why) };
    }
    case 'killed':
      return { type: 'kill' };
  }
}

/** What `record` or `recordLost` did with a run. */
export type RecordOutcome =
  | { kind: 'applied'; event: IssueEvent['type'] }
  // The run is no longer the issue's current one, or the issue has left `fixing`: the row is
  // kept for the record, and the issue is left alone.
  | { kind: 'stale' }
  // recordLost only: the daemon's run_finished job for the run is still queued, and it will
  // move the issue when it is recorded.
  | { kind: 'result_pending' }
  | { kind: 'no_issue' };

/** What a transaction did, and the issue change to log once it commits. */
interface Recorded {
  outcome: RecordOutcome;
  moved?: Moved;
}

/**
 * The error pg-boss kept for a failed job: `{ message }` for an error the worker threw, or
 * `{ value: { message } }` for an expiry.
 */
export function failureMessage(output: unknown): string {
  const message = (value: unknown): string | undefined =>
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
      ? value.message
      : undefined;
  const value =
    typeof output === 'object' && output !== null && 'value' in output ? output.value : undefined;
  return message(output) ?? message(value) ?? 'no error was recorded';
}

/**
 * Records what the node daemon reports for each fix run (#8, #136). The `run_finished` job
 * is the record; the gateway (#34) will relay the same result to the UI later.
 */
@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly issues: IssuesService,
    @Inject(JOB_QUEUES) private readonly jobs: JobQueues,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Writes the `runs` row, then applies the issue event and, for an escalation, writes the
   * `escalations` row, all in one transaction. The event queues the next tier's fix job with
   * the report and the escalation note. Safe to retry: the run row is upserted, and a result
   * whose run is no longer current only updates its row. Applying the event makes the run
   * stale, so the escalation is written once.
   */
  async record(job: RunFinishedJob): Promise<RecordOutcome> {
    const { result } = job;
    const log = issueLogger(this.logger, {
      issueId: job.issueId,
      runId: result.runId,
      tier: job.tier,
    });

    const recorded = await this.db.transaction().execute(async (trx): Promise<Recorded> => {
      const issue = await lockIssue(trx, job.issueId);
      if (!issue) return { outcome: { kind: 'no_issue' } };

      const row = {
        issue_id: job.issueId,
        tier: job.tier,
        status: result.status,
        started_at: new Date(job.startedAt),
        finished_at: new Date(job.finishedAt),
        pr_url: result.prUrl,
        confidence: result.confidence === null ? null : JSON.stringify(result.confidence),
        diff: job.diff,
      };
      await trx
        .insertInto('runs')
        .values({ id: result.runId, ...row })
        .onConflict((oc) => oc.column('id').doUpdateSet(row))
        .execute();

      if (!isCurrent(issue, result.runId)) return { outcome: { kind: 'stale' } };
      const event = issueEventFor(result);
      const moved = await this.issues.applyIn(
        trx,
        job.issueId,
        event,
        result.note === null ? {} : { escalationNote: result.note },
      );
      // Only an escalation the issue took is recorded: a run that escalates after the issue
      // was killed never reached the next tier.
      if (result.status === 'escalated') {
        await trx
          .insertInto('escalations')
          .values({
            run_id: result.runId,
            from_tier: job.tier,
            to_tier: result.toTier,
            reason: result.reason,
            note: JSON.stringify(result.note),
          })
          .execute();
      }
      return { outcome: { kind: 'applied', event: event.type }, moved };
    });

    const { outcome } = this.committed(recorded);
    if (outcome.kind === 'no_issue') {
      log.error({ status: result.status }, 'run finished for an issue that does not exist');
    } else if (outcome.kind === 'applied') {
      log.info({ status: result.status, event: outcome.event }, 'run recorded');
    } else {
      log.warn({ status: result.status }, 'recorded a run that is no longer current; issue left');
    }
    return outcome;
  }

  /**
   * Fails the issue of a fix job that pg-boss failed with no result from the daemon: the
   * daemon died or hung until the job expired, or it could not queue the result. `why` is
   * the error pg-boss kept. Writes a `failed` runs row and applies `fail` in one transaction.
   *
   * Leaves the issue alone when the run is no longer current, or when the daemon's
   * run_finished job for it is still queued: a daemon whose cleanup broke after it queued
   * the result also fails the job, and recording that result moves the issue. Safe to
   * retry, and a result that arrives later is stale and only fills in its row.
   */
  async recordLost(job: FixJob, why: string): Promise<RecordOutcome> {
    const { issueId, runId, tier } = job;
    const log = issueLogger(this.logger, { issueId, runId, tier });
    const { outcome } = await this.failRun(
      { id: runId, issue_id: issueId, tier, status: 'failed', finished_at: new Date() },
      `The fix job failed with no result from the node: ${why}`,
      { unlessResultPending: true },
    );

    if (outcome.kind === 'no_issue') {
      log.error({ why }, 'fix job failed for an issue that does not exist');
    } else if (outcome.kind === 'applied') {
      log.warn({ why }, 'fix job failed with no result; issue failed');
    } else {
      log.info({ why, outcome: outcome.kind }, 'fix job failed; issue left');
    }
    return outcome;
  }

  /**
   * Fails the issue of a run whose run_finished job pg-boss failed for good: `record` threw on
   * every retry, so the issue would otherwise stay in `fixing`. `why` is the error pg-boss
   * kept. Writes the run's row without its diff, which a human taking over can do without, and
   * applies `fail` in one transaction. Leaves the issue alone when the run is no longer
   * current. Safe to retry.
   */
  async recordFailedResult(job: RunFinishedJob, why: string): Promise<RecordOutcome> {
    const { issueId, tier, result } = job;
    const log = issueLogger(this.logger, { issueId, runId: result.runId, tier });
    const { outcome } = await this.failRun(
      {
        id: result.runId,
        issue_id: issueId,
        tier,
        status: result.status,
        started_at: new Date(job.startedAt),
        finished_at: new Date(job.finishedAt),
        pr_url: result.prUrl,
      },
      `The node's result for the run could not be recorded: ${why}`,
      { unlessResultPending: false },
    );

    if (outcome.kind === 'no_issue') {
      log.error({ why }, 'result could not be recorded for an issue that does not exist');
    } else if (outcome.kind === 'applied') {
      log.error({ why, status: result.status }, 'result could not be recorded; issue failed');
    } else {
      log.info({ why, outcome: outcome.kind }, 'result could not be recorded; issue left');
    }
    return outcome;
  }

  /**
   * In one transaction: writes `run` unless the run already has a row, and fails its issue if
   * the run is still current. With `unlessResultPending`, a run_finished job still queued for
   * the run is left to move the issue instead.
   */
  private async failRun(
    run: Insertable<RunsTable>,
    why: string,
    { unlessResultPending }: { unlessResultPending: boolean },
  ): Promise<Recorded> {
    const recorded = await this.db.transaction().execute(async (trx): Promise<Recorded> => {
      const issue = await lockIssue(trx, run.issue_id);
      if (!issue) return { outcome: { kind: 'no_issue' } };
      if (!isCurrent(issue, run.id)) return { outcome: { kind: 'stale' } };
      if (unlessResultPending && (await this.jobs.runFinishedPending(run.id, trx))) {
        return { outcome: { kind: 'result_pending' } };
      }

      await trx
        .insertInto('runs')
        .values(run)
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      const event: IssueEvent = { type: 'fail', runId: run.id, reason: reason(why) };
      const moved = await this.issues.applyIn(trx, run.issue_id, event);
      return { outcome: { kind: 'applied', event: event.type }, moved };
    });
    return this.committed(recorded);
  }

  /** Hands the committed issue change to afterCommit, so a rollback never shows up. */
  private committed(recorded: Recorded): Recorded {
    if (recorded.moved) this.issues.afterCommit(recorded.moved);
    return recorded;
  }
}

/** Locks the issue row, so a concurrent event on the issue waits for this transaction. */
function lockIssue(trx: Transaction<Database>, issueId: string) {
  return trx
    .selectFrom('issues')
    .select(['status', 'current_run_id'])
    .where('id', '=', issueId)
    .forUpdate()
    .executeTakeFirst();
}

/** Whether `runId` is the run the issue is waiting on. */
function isCurrent(issue: { status: string; current_run_id: string | null }, runId: string) {
  return issue.status === 'fixing' && issue.current_run_id === runId;
}
