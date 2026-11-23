import { Inject, Injectable } from '@nestjs/common';
import {
  TERMINAL_ISSUE_STATUSES,
  type EscalationNote,
  type Issue,
  type IssueEvent,
  type IssueEventRecord,
  type IssueStatus,
  type NewIssue,
} from '@page/contracts';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { Database, Db, IssueEventsTable, IssuesTable } from '../db/database.ts';
import { titleReport } from '../ingest/report.ts';
import { issueLogger, type Logger } from '../logger.ts';
import type { FixJobQueue } from '../queue/fix-jobs.ts';
import { DB, FIX_JOB_QUEUE, LOGGER } from '../tokens.ts';
import { IssueUpdates } from './issue-updates.ts';
import { isTerminal, IssueStateMachine } from './transitions.ts';

export class IssueNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`issue ${id} not found`);
    this.name = 'IssueNotFoundError';
  }
}

/** A daemon event names a run that is no longer the issue's current one. */
export class StaleRunError extends Error {
  constructor(
    readonly id: string,
    readonly runId: string,
  ) {
    super(`run ${runId} is not the current run of issue ${id}`);
    this.name = 'StaleRunError';
  }
}

function toIssue(row: Selectable<IssuesTable>): Issue {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    status: row.status,
    class: row.class,
    severity: row.severity,
    occurrences: row.occurrences,
    currentTier: row.current_tier,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ApplyOptions {
  /**
   * What the run below left for the tier this event enters. A `reject` without one passes
   * the reviewer's reason on instead.
   */
  escalationNote?: EscalationNote;
}

/** A change `applyIn` made, logged and published once its transaction commits. */
export interface Moved {
  event: IssueEvent;
  issue: Issue;
  from: IssueStatus;
  runId: string | null;
  cancelledRunId: string | undefined;
}

/** The note a rejected patch hands the next tier: the reviewer's reason is the blocker. */
function rejectionNote(tier: number | null, reason: string): EscalationNote {
  return {
    summary: `A reviewer rejected the Tier ${tier ?? '?'} fix.`,
    tried: [],
    blocker: reason,
  };
}

function toEventRecord(row: Selectable<IssueEventsTable>): IssueEventRecord {
  return {
    id: String(row.id),
    issueId: row.issue_id,
    event: row.event,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    currentTier: row.current_tier,
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class IssuesService {
  private readonly machine = new IssueStateMachine();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIX_JOB_QUEUE) private readonly fixJobs: FixJobQueue,
    @Inject(LOGGER) private readonly logger: Logger,
    // Nest injects the shared one. Tests that build the service by hand get their own.
    private readonly updates: IssueUpdates = new IssueUpdates(logger),
  ) {}

  /**
   * Opens an issue, or counts another occurrence of the open one with this fingerprint.
   * `report` is the sanitized error report fix jobs carry. A repeat keeps the first one and
   * only fills it in when the issue had none. Both publish the issue, since a repeat changes
   * `occurrences`.
   */
  async report(input: NewIssue, report?: string): Promise<{ issue: Issue; created: boolean }> {
    const row = await this.db
      .insertInto('issues')
      .values({ ...input, report: report ?? null })
      .onConflict((oc) =>
        oc
          .column('fingerprint')
          // Must match the predicate of the issues_open_fingerprint partial index.
          .where('status', 'not in', [...TERMINAL_ISSUE_STATUSES])
          .doUpdateSet({
            occurrences: sql<number>`issues.occurrences + 1`,
            last_seen_at: sql<Date>`now()`,
            // list() sorts by updated_at, so a recurring issue stays near the top.
            updated_at: sql<Date>`now()`,
            report: sql<string | null>`coalesce(issues.report, excluded.report)`,
          }),
      )
      .returningAll()
      // xmax is 0 only on a freshly inserted row.
      .returning(sql<boolean>`xmax = 0`.as('created'))
      .executeTakeFirstOrThrow();
    const { created, ...issue } = row;
    if (created) issueLogger(this.logger, { issueId: issue.id }).info('issue opened');
    const reported = toIssue(issue);
    this.updates.publish(reported);
    return { issue: reported, created };
  }

  async list(status?: IssueStatus): Promise<Issue[]> {
    let query = this.db.selectFrom('issues').selectAll().orderBy('updated_at', 'desc').limit(200);
    if (status) query = query.where('status', '=', status);
    return (await query.execute()).map(toIssue);
  }

  async get(id: string): Promise<Issue> {
    const row = await this.db
      .selectFrom('issues')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new IssueNotFoundError(id);
    return toIssue(row);
  }

  /** The sanitized report ingest stored, or null for an issue opened without one. */
  async storedReport(id: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('issues')
      .select('report')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new IssueNotFoundError(id);
    return row.report;
  }

  async events(id: string): Promise<IssueEventRecord[]> {
    await this.get(id);
    const rows = await this.db
      .selectFrom('issue_events')
      .selectAll()
      .where('issue_id', '=', id)
      .orderBy('id')
      .execute();
    return rows.map(toEventRecord);
  }

  /**
   * How many fixes started (triaged to fixing) in the last `ms` milliseconds, whether triage
   * or an operator started them. Triage reads it to cap automatic starts.
   */
  async fixesStartedWithin(ms: number): Promise<number> {
    const row = await this.db
      .selectFrom('issue_events')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('from_status', '=', 'triaged')
      .where('to_status', '=', 'fixing')
      .where('created_at', '>', sql<Date>`now() - ${ms} * interval '1 millisecond'`)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Applies `event`, records it, and keeps the fix queue in step, all in one transaction:
   * entering a tier queues a job for it, and entering a new tier or a terminal status
   * cancels the job it replaces. Throws TransitionError if the event does not apply, and
   * StaleRunError if a daemon event names a run other than the current one.
   */
  async apply(id: string, event: IssueEvent, options: ApplyOptions = {}): Promise<Issue> {
    const moved = await this.db
      .transaction()
      .execute((trx) => this.applyIn(trx, id, event, options));
    // After the commit, so a rolled-back change is never logged or sent to the UI.
    this.afterCommit(moved);
    return moved.issue;
  }

  /**
   * Logs `issue moved` for a change and publishes the issue to IssueUpdates. Every status
   * change passes through here once the transaction that made it has committed.
   */
  afterCommit({ event, issue, from, runId, cancelledRunId }: Moved): void {
    issueLogger(this.logger, { issueId: issue.id, runId, tier: issue.currentTier }).info(
      { event: event.type, from, to: issue.status, cancelledRunId },
      'issue moved',
    );
    this.updates.publish(issue);
  }

  /**
   * `apply` inside the caller's transaction, so the change commits or rolls back with the
   * caller's own writes (RunsService). Nothing is logged or published: the caller passes the
   * result to `afterCommit` once its transaction commits.
   */
  async applyIn(
    trx: Transaction<Database>,
    id: string,
    event: IssueEvent,
    { escalationNote }: ApplyOptions = {},
  ): Promise<Moved> {
    const current = await trx
      .selectFrom('issues')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new IssueNotFoundError(id);

    const next = this.machine.apply(
      {
        status: current.status,
        class: current.class,
        severity: current.severity,
        currentTier: current.current_tier,
      },
      event,
    );
    // A retried or late event from an earlier run must not move the current one.
    if ('runId' in event && event.runId !== current.current_run_id) {
      throw new StaleRunError(id, event.runId);
    }

    const enteredTier =
      next.status === 'fixing' &&
      (current.status !== 'fixing' || current.current_tier !== next.currentTier);
    let cancelledRunId: string | undefined;
    if ((enteredTier || isTerminal(next.status)) && current.current_run_id) {
      await this.fixJobs.cancel(current.current_run_id, trx);
      cancelledRunId = current.current_run_id;
    }
    let runId = current.current_run_id;
    const note =
      escalationNote ??
      (event.type === 'reject' ? rejectionNote(current.current_tier, event.reason) : undefined);
    if (enteredTier && next.currentTier !== null) {
      const job = await this.fixJobs.send(
        {
          issueId: id,
          fingerprint: current.fingerprint,
          tier: next.currentTier,
          // An issue opened without a report still gives the agent its error, masked as
          // ingest masks one, since a Tier 2 PR is public.
          report: current.report ?? titleReport(current.title),
          ...(note === undefined ? {} : { escalationNote: note }),
        },
        trx,
      );
      if (!job) throw new Error(`fix job for ${current.fingerprint} is already queued`);
      runId = job.runId;
    }

    const updated = await trx
      .updateTable('issues')
      .set({
        status: next.status,
        class: next.class,
        severity: next.severity,
        current_tier: next.currentTier,
        current_run_id: runId,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('issue_events')
      .values({
        issue_id: id,
        event: JSON.stringify(event),
        from_status: current.status,
        to_status: next.status,
        current_tier: next.currentTier,
      })
      .execute();
    return { event, issue: toIssue(updated), from: current.status, runId, cancelledRunId };
  }
}
