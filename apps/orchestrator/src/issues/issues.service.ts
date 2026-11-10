import { Inject, Injectable } from '@nestjs/common';
import {
  TERMINAL_ISSUE_STATUSES,
  type Issue,
  type IssueEvent,
  type IssueEventRecord,
  type IssueStatus,
  type NewIssue,
} from '@page/contracts';
import { sql, type Selectable } from 'kysely';
import type { Db, IssueEventsTable, IssuesTable } from '../db/database.ts';
import { issueLogger, type Logger } from '../logger.ts';
import type { FixJobQueue } from '../queue/fix-jobs.ts';
import { DB, FIX_JOB_QUEUE, LOGGER } from '../tokens.ts';
import { isTerminal, transition } from './transitions.ts';

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
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIX_JOB_QUEUE) private readonly fixJobs: FixJobQueue,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Opens an issue, or counts another occurrence of the open one with this fingerprint. */
  async report(input: NewIssue): Promise<{ issue: Issue; created: boolean }> {
    const row = await this.db
      .insertInto('issues')
      .values(input)
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
          }),
      )
      .returningAll()
      // xmax is 0 only on a freshly inserted row.
      .returning(sql<boolean>`xmax = 0`.as('created'))
      .executeTakeFirstOrThrow();
    const { created, ...issue } = row;
    if (created) issueLogger(this.logger, { issueId: issue.id }).info('issue opened');
    return { issue: toIssue(issue), created };
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
   * Applies `event`, records it, and keeps the fix queue in step, all in one transaction:
   * entering a tier queues a job for it, and entering a new tier or a terminal status
   * cancels the job it replaces. Throws TransitionError if the event does not apply, and
   * StaleRunError if a daemon event names a run other than the current one.
   */
  async apply(id: string, event: IssueEvent): Promise<Issue> {
    const moved = await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('issues')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new IssueNotFoundError(id);

      const next = transition(
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
      if (enteredTier && next.currentTier !== null) {
        const job = await this.fixJobs.send(
          { issueId: id, fingerprint: current.fingerprint, tier: next.currentTier },
          trx,
        );
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
      return { issue: toIssue(updated), from: current.status, runId, cancelledRunId };
    });

    // Logged after the commit, so a rolled-back change never shows up.
    const { issue, from, runId, cancelledRunId } = moved;
    issueLogger(this.logger, { issueId: id, runId, tier: issue.currentTier }).info(
      { event: event.type, from, to: issue.status, cancelledRunId },
      'issue moved',
    );
    return issue;
  }
}
