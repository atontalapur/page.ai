import { Inject, Injectable } from '@nestjs/common';
import type { IssueEvent, JobPayload } from '@page/contracts';
import type { Transaction } from 'kysely';
import type { Database, Db } from '../db/database.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { issueLogger, type Logger } from '../logger.ts';
import type { FixJob } from '../queue/fix-jobs.ts';
import type { JobQueues } from '../queue/queues.ts';
import { DB, JOB_QUEUES, LOGGER } from '../tokens.ts';

export type RunFinishedJob = JobPayload<'run_finished'>;
type RunResult = RunFinishedJob['result'];

const REASON_MAX = 2000;

const clip = (text: string) =>
  text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 3)}...`;

/**
 * The issue event a run's result applies. A success is a patch for review. An escalation
 * moves up a tier (or to `failed` past Tier 3) and hands its note to the next run. A failure
 * goes straight to `failed`: the daemon only fails a run a higher tier can't fix. A killed
 * run kills the issue.
 */
export function issueEventFor(result: RunResult): IssueEvent {
  const { runId } = result;
  switch (result.status) {
    case 'succeeded':
      return { type: 'patch_ready', runId };
    case 'escalated':
      return { type: 'escalate', runId, reason: clip(`${result.reason}: ${result.note.summary}`) };
    case 'failed': {
      const why = result.note ? `${result.note.summary} ${result.note.blocker}` : 'The run failed.';
      return { type: 'fail', runId, reason: clip(why) };
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

    const outcome = await this.db.transaction().execute(async (trx): Promise<RecordOutcome> => {
      const issue = await lockIssue(trx, job.issueId);
      if (!issue) return { kind: 'no_issue' };

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

      if (!isCurrent(issue, result.runId)) return { kind: 'stale' };
      const event = issueEventFor(result);
      await this.issues.apply(job.issueId, event, {
        trx,
        ...(result.note === null ? {} : { escalationNote: result.note }),
      });
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
      return { kind: 'applied', event: event.type };
    });

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

    const outcome = await this.db.transaction().execute(async (trx): Promise<RecordOutcome> => {
      const issue = await lockIssue(trx, issueId);
      if (!issue) return { kind: 'no_issue' };
      if (!isCurrent(issue, runId)) return { kind: 'stale' };
      if (await this.jobs.runFinishedPending(runId, trx)) return { kind: 'result_pending' };

      await trx
        .insertInto('runs')
        .values({ id: runId, issue_id: issueId, tier, status: 'failed', finished_at: new Date() })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      const event: IssueEvent = {
        type: 'fail',
        runId,
        reason: clip(`The fix job failed with no result from the node: ${why}`),
      };
      await this.issues.apply(issueId, event, { trx });
      return { kind: 'applied', event: event.type };
    });

    if (outcome.kind === 'no_issue') {
      log.error({ why }, 'fix job failed for an issue that does not exist');
    } else if (outcome.kind === 'applied') {
      log.warn({ why }, 'fix job failed with no result; issue failed');
    } else {
      log.info({ why, outcome: outcome.kind }, 'fix job failed; issue left');
    }
    return outcome;
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
