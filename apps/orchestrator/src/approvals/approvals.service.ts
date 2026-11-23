import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  approvalReason,
  MAX_APPROVAL_WAIT_MS,
  SYSTEM_DECIDERS,
  type Approval,
  type DecidedApproval,
  type NodeToServerEvents,
} from '@page/contracts';
import { sql, type Selectable } from 'kysely';
import type { ApprovalsTable, Db } from '../db/database.ts';
import { IssueUpdates } from '../issues/issue-updates.ts';
import type { IssueUpdates as Updates } from '../issues/issue-updates.ts';
import { IssueNotFoundError } from '../issues/issues.service.ts';
import type { Logger } from '../logger.ts';
import { RunsService } from '../runs/runs.service.ts';
import type { RunsService as Runs } from '../runs/runs.service.ts';
import { DB, LOGGER } from '../tokens.ts';

export type ApprovalRequest = Parameters<NodeToServerEvents['node.approval.request']>[0];

/** Each approval as it is requested or decided. GatewayModule relays it to tabs and daemons. */
export type ApprovalListener = (approval: Approval) => void;

/** What decide() did with a person's decision. */
export type DecideOutcome =
  | { kind: 'decided'; approval: DecidedApproval }
  // Someone, or the server, decided first. The decision stands and this one is refused.
  | { kind: 'already_decided'; approval: DecidedApproval }
  // Past its deadline: the server rejected it as timed out instead.
  | { kind: 'expired'; approval: DecidedApproval }
  | { kind: 'not_found' };

type Row = Selectable<ApprovalsTable>;

/**
 * Holds Tier 3 requests to run gated host tools like `ops.restart`, and their decisions.
 *
 * A daemon's `node.approval.request` is stored pending, under the issue whose run asked, with
 * the agent's reason for it, and every listener hears of it. The first decision wins: a
 * person's from the UI (`ui:<name>`), or the server's when the deadline passes
 * (`system:timed_out`) or the run stops waiting (`system:run_ended`: it finished, was killed
 * or replaced). A later decision is refused and changes nothing. Listeners hear each decision
 * once it is stored.
 *
 * Deadlines are kept with timers on the instance that stored the request, and set again at
 * boot for every request still pending, so a restart can't leave one open. A decision is
 * also refused once the row's `expires_at` has passed, whatever the timers did.
 */
@Injectable()
export class ApprovalsService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly listeners = new Set<ApprovalListener>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | undefined;

  // Type-only aliases for the class-typed parameters: oxc emits a metadata branch for a class
  // type that no test can reach, which fails the strict coverage glob on approval code.
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RunsService) private readonly runs: Runs,
    @Inject(IssueUpdates) private readonly updates: Updates,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.updates.subscribe((issue, { cancelledRunId }) => {
      // A cancelled run's daemon is told to stop, and an issue out of `fixing` has no run in
      // progress, so neither can use an answer.
      if (cancelledRunId !== undefined) this.closeLater({ runId: cancelledRunId });
      if (issue.status !== 'fixing') this.closeLater({ issueId: issue.id });
    });
  }

  /** Sets a deadline timer for every request still pending, such as after a restart. */
  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.db
      .selectFrom('approvals')
      .selectAll()
      .where('decision', '=', 'pending')
      .execute();
    for (const row of rows) this.schedule(toApproval(row));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Adds `listener`, and returns the function that removes it. */
  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Stores a daemon's request, pending, and tells listeners. Safe to repeat: a daemon sends
   * its requests again after a reconnect, and one decided meanwhile is told to listeners
   * again, so the daemon gets its answer. A request from a run that is no longer its issue's
   * run in progress is stored decided (`system:run_ended`) and answered at once. Undefined for
   * a run no issue knows, or an id another run already used.
   */
  async request(request: ApprovalRequest): Promise<Approval | undefined> {
    const { approvalId, runId } = request;
    const owner = await this.runs.owner(runId);
    if (owner === undefined) {
      this.logger.warn({ approvalId, runId }, 'approval request for a run no issue knows; dropped');
      return undefined;
    }
    const now = Date.now();
    const closed = owner.current
      ? {}
      : {
          decision: 'rejected' as const,
          decided_by: SYSTEM_DECIDERS.runEnded,
          decided_at: new Date(now),
        };
    const inserted = await this.db
      .insertInto('approvals')
      .values({
        id: approvalId,
        run_id: runId,
        issue_id: owner.issueId,
        action: request.action,
        args: JSON.stringify(request.args),
        // The daemon's deadline, held to the longest a run could wait.
        expires_at: new Date(Math.min(Date.parse(request.expiresAt), now + MAX_APPROVAL_WAIT_MS)),
        // The model's words, cleaned again here: the contract caps them but lets control
        // characters through, and a daemon older than the field sends none.
        reason: approvalReason(request.reason),
        ...closed,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .returningAll()
      .executeTakeFirst();
    const log = this.logger.child({ approvalId, runId, issueId: owner.issueId });

    if (inserted !== undefined) {
      const approval = toApproval(inserted);
      log.info({ action: approval.action, decision: approval.decision }, 'approval requested');
      this.schedule(approval);
      this.publish(approval);
      return approval;
    }

    const row = await this.find(approvalId);
    if (row?.run_id !== runId) {
      log.error('approval id already used by another run; dropped');
      return undefined;
    }
    const approval = toApproval(row);
    log.info({ decision: approval.decision }, 'approval requested again');
    if (approval.decision === 'pending') {
      this.schedule(approval);
      return approval;
    }
    this.publish(approval);
    return approval;
  }

  /**
   * Records a person's decision, unless the approval was decided already or is past its
   * deadline. `decidedBy` comes from the deciding socket, never from what it sent.
   */
  async decide(
    approvalId: string,
    decision: DecidedApproval['decision'],
    decidedBy: string,
  ): Promise<DecideOutcome> {
    const row = await this.db
      .updateTable('approvals')
      .set({ decision, decided_by: decidedBy, decided_at: sql<Date>`now()` })
      .where('id', '=', approvalId)
      .where('decision', '=', 'pending')
      .where('expires_at', '>', sql<Date>`now()`)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) {
      const approval = toApproval(row) as DecidedApproval;
      this.logger.info(
        { approvalId, runId: approval.runId, issueId: approval.issueId, decision, decidedBy },
        'approval decided',
      );
      this.settled(approval);
      return { kind: 'decided', approval };
    }

    const current = await this.find(approvalId);
    if (current === undefined) return { kind: 'not_found' };
    if (current.decision === 'pending') {
      const [expired] = await this.close({ id: approvalId }, SYSTEM_DECIDERS.timedOut);
      if (expired !== undefined) return { kind: 'expired', approval: expired };
    }
    const decided = toApproval((await this.find(approvalId))!) as DecidedApproval;
    this.logger.warn(
      { approvalId, decision, decidedBy, decided: decided.decision, by: decided.decidedBy },
      'second decision on an approval refused',
    );
    return { kind: 'already_decided', approval: decided };
  }

  /** Rejects a run's pending requests once it has finished, as `system:run_ended`. */
  async closeRun(runId: string): Promise<DecidedApproval[]> {
    return this.close({ runId }, SYSTEM_DECIDERS.runEnded);
  }

  /** An issue's approvals, oldest first. Throws IssueNotFoundError for an unknown issue. */
  async forIssue(issueId: string): Promise<Approval[]> {
    const issue = await this.db
      .selectFrom('issues')
      .select('id')
      .where('id', '=', issueId)
      .executeTakeFirst();
    if (issue === undefined) throw new IssueNotFoundError(issueId);
    const rows = await this.db
      .selectFrom('approvals')
      .selectAll()
      .where('issue_id', '=', issueId)
      .orderBy('requested_at')
      .orderBy('id')
      .execute();
    return rows.map(toApproval);
  }

  /** A run's approvals, oldest first. Empty for a run that asked for none. */
  async forRun(runId: string): Promise<Approval[]> {
    const rows = await this.db
      .selectFrom('approvals')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('requested_at')
      .orderBy('id')
      .execute();
    return rows.map(toApproval);
  }

  private find(approvalId: string): Promise<Row | undefined> {
    return this.db
      .selectFrom('approvals')
      .selectAll()
      .where('id', '=', approvalId)
      .executeTakeFirst();
  }

  /** Rejects the pending requests that match, as `decidedBy`, and tells listeners. */
  private async close(
    match: { id: string } | { runId: string } | { issueId: string },
    decidedBy: string,
  ): Promise<DecidedApproval[]> {
    let query = this.db
      .updateTable('approvals')
      .set({ decision: 'rejected', decided_by: decidedBy, decided_at: sql<Date>`now()` })
      .where('decision', '=', 'pending');
    if ('id' in match) query = query.where('id', '=', match.id);
    else if ('runId' in match) query = query.where('run_id', '=', match.runId);
    else query = query.where('issue_id', '=', match.issueId);
    const rows = await query.returningAll().execute();
    const closed = rows.map((row) => toApproval(row) as DecidedApproval);
    for (const approval of closed) {
      this.logger.info(
        { approvalId: approval.id, runId: approval.runId, issueId: approval.issueId, decidedBy },
        'approval closed by the server',
      );
      this.settled(approval);
    }
    return closed;
  }

  /** close() from a listener that can't wait on it. A failure is logged. */
  private closeLater(match: { runId: string } | { issueId: string }): void {
    this.close(match, SYSTEM_DECIDERS.runEnded).catch((err: unknown) => {
      this.logger.error({ err, ...match }, 'could not close the approvals of a run that ended');
    });
  }

  /** Rejects a pending request as timed out at its deadline, on this instance. */
  private schedule(approval: Approval): void {
    if (approval.decision !== 'pending' || this.timers.has(approval.id)) return;
    const ms = Math.max(0, Date.parse(approval.expiresAt) - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(approval.id);
      this.close({ id: approval.id }, SYSTEM_DECIDERS.timedOut).catch((err: unknown) => {
        this.logger.error({ err, approvalId: approval.id }, 'could not time out an approval');
      });
    }, ms);
    timer.unref();
    this.timers.set(approval.id, timer);
  }

  private settled(approval: DecidedApproval): void {
    clearTimeout(this.timers.get(approval.id));
    this.timers.delete(approval.id);
    this.publish(approval);
  }

  private publish(approval: Approval): void {
    for (const listener of this.listeners) {
      try {
        listener(approval);
      } catch (err) {
        this.logger.error({ err, approvalId: approval.id }, 'approval listener failed');
      }
    }
  }
}

function toApproval(row: Row): Approval {
  const base = {
    id: row.id,
    runId: row.run_id,
    issueId: row.issue_id,
    action: row.action,
    args: row.args,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    reason: row.reason,
  };
  if (row.decision === 'pending') {
    return { ...base, decision: 'pending', decidedBy: null, decidedAt: null };
  }
  return {
    ...base,
    decision: row.decision,
    decidedBy: row.decided_by!,
    decidedAt: row.decided_at!.toISOString(),
  };
}
