import { Inject, Injectable } from '@nestjs/common';
import {
  clip,
  MAX_REASON_CHARS,
  type IssueEvent,
  type IssueRun,
  type JobPayload,
  type Step,
  type Tier,
} from '@page/contracts';
import type { Insertable, Selectable, Transaction } from 'kysely';
import type { Database, Db, RunsTable, StepsTable } from '../db/database.ts';
import { IssueNotFoundError, IssuesService, type Moved } from '../issues/issues.service.ts';
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

/** The issue a run belongs to, for the gateway to relay the run's events. */
export interface RunOwner {
  issueId: string;
  tier: Tier;
  /** The issue is fixing with this as its current run: the run a daemon should be on. */
  current: boolean;
  /** As `forIssue` gives it: the row's, or the first step's while the run has no row. */
  startedAt: string | null;
}

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
   * Every run of an issue, oldest first, each with its steps: the finished ones from `runs`,
   * and the one in progress, which has only its steps until the daemon reports it. Throws
   * IssueNotFoundError for an unknown issue.
   */
  async forIssue(issueId: string): Promise<IssueRun[]> {
    const issue = await this.db
      .selectFrom('issues')
      .select(['status', 'current_run_id', 'current_tier'])
      .where('id', '=', issueId)
      .executeTakeFirst();
    if (!issue) throw new IssueNotFoundError(issueId);

    const rows = await this.db
      .selectFrom('runs')
      .selectAll()
      .where('issue_id', '=', issueId)
      .orderBy('created_at')
      .execute();
    const current = issue.current_run_id;
    // Only a fixing issue has a run in hand; past that, its current run has a row or never ran.
    const inProgress =
      issue.status === 'fixing' && current !== null && !rows.some((r) => r.id === current)
        ? current
        : undefined;
    const ids = [...rows.map((r) => r.id), ...(inProgress ? [inProgress] : [])];
    const steps =
      ids.length === 0
        ? []
        : await this.db
            .selectFrom('steps')
            .selectAll()
            .where('run_id', 'in', ids)
            .orderBy('run_id')
            .orderBy('seq')
            .execute();
    const stepsOf = (id: string) => steps.filter((step) => step.run_id === id).map(toStep);

    const runs: IssueRun[] = rows.map((row) => ({
      id: row.id,
      issueId,
      tier: row.tier,
      status: row.status,
      startedAt: row.started_at?.toISOString() ?? null,
      finishedAt: row.finished_at?.toISOString() ?? null,
      prUrl: row.pr_url,
      confidence: row.confidence,
      diff: row.diff,
      steps: stepsOf(row.id),
    }));
    if (inProgress && issue.current_tier !== null) {
      const own = stepsOf(inProgress);
      runs.push({
        id: inProgress,
        issueId,
        tier: issue.current_tier,
        status: own.length > 0 ? 'running' : 'queued',
        startedAt: own[0]?.createdAt ?? null,
        finishedAt: null,
        prUrl: null,
        confidence: null,
        diff: null,
        steps: own,
      });
    }
    return runs;
  }

  /**
   * Whose run `runId` is: the issue waiting on it, or the issue on its `runs` row once it
   * has one. Undefined for a run neither knows, such as one a new tier replaced before it
   * reported.
   */
  async owner(runId: string): Promise<RunOwner | undefined> {
    const issue = await this.db
      .selectFrom('issues')
      .select(['id', 'status', 'current_tier'])
      .where('current_run_id', '=', runId)
      .executeTakeFirst();
    const current = issue?.status === 'fixing';
    const row = await this.db
      .selectFrom('runs')
      .select(['issue_id', 'tier', 'started_at'])
      .where('id', '=', runId)
      .executeTakeFirst();
    if (row) {
      const startedAt = row.started_at?.toISOString() ?? null;
      return { issueId: row.issue_id, tier: row.tier, current, startedAt };
    }
    if (!issue || issue.current_tier === null) return undefined;
    const first = await this.db
      .selectFrom('steps')
      .select('created_at')
      .where('run_id', '=', runId)
      .orderBy('seq')
      .limit(1)
      .executeTakeFirst();
    return {
      issueId: issue.id,
      tier: issue.current_tier,
      current,
      startedAt: first?.created_at.toISOString() ?? null,
    };
  }

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

function toStep(row: Selectable<StepsTable>): Step {
  return {
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind,
    input: row.input,
    outputTrimmed: row.output_trimmed,
    exitCode: row.exit_code,
    allowed: row.allowed,
    thought: row.thought,
    createdAt: row.created_at.toISOString(),
  };
}
