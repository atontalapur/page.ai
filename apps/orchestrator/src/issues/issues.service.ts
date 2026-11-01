import { Inject, Injectable } from '@nestjs/common';
import type { Issue, IssueEvent, IssueEventRecord, IssueStatus, NewIssue } from '@page/contracts';
import { sql, type Selectable } from 'kysely';
import type { Db, IssueEventsTable, IssuesTable } from '../db/database.ts';
import type { FixJobQueue } from '../queue/fix-jobs.ts';
import { DB, FIX_JOB_QUEUE } from '../tokens.ts';
import { transition } from './transitions.ts';

export class IssueNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`issue ${id} not found`);
    this.name = 'IssueNotFoundError';
  }
}

function toIssue(row: Selectable<IssuesTable>): Issue {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    status: row.status,
    category: row.category,
    severity: row.severity,
    tier: row.tier,
    occurrences: row.occurrences,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

function toEventRecord(row: Selectable<IssueEventsTable>): IssueEventRecord {
  return {
    id: String(row.id),
    issueId: row.issue_id,
    event: row.event,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    tier: row.tier,
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class IssuesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(FIX_JOB_QUEUE) private readonly fixJobs: FixJobQueue,
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
          .where('status', 'not in', ['resolved', 'unresolved', 'killed'])
          .doUpdateSet({
            occurrences: sql<number>`issues.occurrences + 1`,
            last_seen_at: sql<Date>`now()`,
          }),
      )
      .returningAll()
      // xmax is 0 only on a freshly inserted row.
      .returning(sql<boolean>`xmax = 0`.as('created'))
      .executeTakeFirstOrThrow();
    const { created, ...issue } = row;
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
   * Applies `event`, records it, and queues a fix job when the issue enters a new tier,
   * all in one transaction. Throws TransitionError if the event does not apply.
   */
  async apply(id: string, event: IssueEvent): Promise<Issue> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('issues')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new IssueNotFoundError(id);

      const next = transition(current, event);
      const updated = await trx
        .updateTable('issues')
        .set({ ...next, updated_at: sql<Date>`now()` })
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
          tier: next.tier,
        })
        .execute();

      const enteredTier =
        next.status === 'fixing' && (current.status !== 'fixing' || current.tier !== next.tier);
      if (enteredTier && next.tier !== null) {
        await this.fixJobs.send({ issueId: id, tier: next.tier }, trx);
      }
      return toIssue(updated);
    });
  }
}
