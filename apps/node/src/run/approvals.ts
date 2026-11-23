import { randomUUID } from 'node:crypto';
import { approvalReason, SYSTEM_DECIDERS, type NodeDecision } from '@page/contracts';
import {
  autoApprove,
  hostToolArgs,
  type ApprovalVerdict,
  type Approve,
  type HostToolCall,
  type OpsHostTools,
} from '@page/toolkit';
import type { Logger } from 'pino';
import type { NodePayload, OrchestratorLink } from '../link/link.ts';

/**
 * How long a run waits for a person, at most. A Tier 3 run has 14 minutes, and a command
 * at most 5 (DEFAULT_TIMEOUT_MS), so an approval that comes at the end still leaves the tool
 * 2 minutes to restart the app or wait for a rollback to go live.
 */
export const APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * How long past its deadline a run still waits for the orchestrator's answer. The server
 * closes a request at its deadline and says so; this covers a clock apart from the server's
 * and the answer in flight. With no answer by then, the run counts the call rejected itself.
 */
export const APPROVAL_GRACE_MS = 10_000;

/** How a run asks a person to approve a gated host tool call (APPROVAL_TOOLS). */
export interface Approvals {
  /**
   * Whether a person answers, so a gated call waits for them. False when every call is
   * approved at once; the agent's prompt then says nothing about approvals.
   */
  readonly asksPerson: boolean;
  /**
   * An Approve for one run. Its waits end when `signal` fires. `args` is what the person
   * sees for a call: its tool and arguments, and for a rollback, what it replaces.
   */
  forRun(run: {
    runId: string;
    signal: AbortSignal;
    args: (call: HostToolCall) => Record<string, unknown>;
  }): Approve;
}

/**
 * Approves every call, as `by`. For runs no person watches and that change nothing shared:
 * fake adapters, an ops app on this machine (AUTO_APPROVE_OPS), and the eval.
 */
export function autoApprovals(by: string): Approvals {
  return { asksPerson: false, forRun: () => autoApprove(by) };
}

export interface LinkApprovalsOptions {
  link: OrchestratorLink;
  logger: Logger;
  /** Milliseconds a run waits for a person (default APPROVAL_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Milliseconds past the deadline a run waits for the server (default APPROVAL_GRACE_MS). */
  graceMs?: number;
  now?: () => number;
  newId?: () => string;
}

interface Waiting {
  request: NodePayload<'node.approval.request'>;
  finish: (verdict: ApprovalVerdict) => void;
  log: Logger;
}

/**
 * Asks a person through the orchestrator: sends `node.approval.request` and waits for the
 * `approval.decided` that answers it. One per daemon: it listens on the link once and hands
 * each answer to the run waiting on it. The request carries the model's thought for the call
 * as its `reason` (approvalReason), so the person sees why the agent asks.
 *
 * A wait ends as a rejection when no one decides by the deadline, when the run is killed or
 * its job expires, and when the server says the run is no longer in progress. The server
 * keeps no event for a socket that was down, so after a reconnect every request still
 * waiting is sent again; the server answers one decided meanwhile with its decision. A link
 * that stays down can't hold a run: the wait still ends at its deadline.
 */
export class LinkApprovals implements Approvals {
  readonly asksPerson = true;
  private readonly link: OrchestratorLink;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly waiting = new Map<string, Waiting>();

  constructor(options: LinkApprovalsOptions) {
    this.link = options.link;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.graceMs = options.graceMs ?? APPROVAL_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.link.on('approval.decided', ({ approval }) => this.decided(approval));
    this.link.onReconnect(() => this.resend());
  }

  forRun({ runId, signal, args }: Parameters<Approvals['forRun']>[0]): Approve {
    return (call, { timeoutMs, thought }) =>
      this.ask(runId, signal, call, args(call), approvalReason(thought), timeoutMs);
  }

  private async ask(
    runId: string,
    signal: AbortSignal,
    call: HostToolCall,
    args: Record<string, unknown>,
    reason: string | null,
    timeoutMs: number,
  ): Promise<ApprovalVerdict> {
    if (signal.aborted) return STOPPED;
    // No longer than the call may take, which is no longer than the run has left.
    const waitMs = Math.max(1, Math.min(this.timeoutMs, timeoutMs));
    const request = {
      v: 1 as const,
      approvalId: this.newId(),
      runId,
      action: call.tool,
      args,
      expiresAt: new Date(this.now() + waitMs).toISOString(),
      reason,
    };
    const log = this.logger.child({ runId, approvalId: request.approvalId, tool: call.tool });
    // Sent first: a request the contract refuses throws here, before anything waits on it.
    this.link.send('node.approval.request', request);
    log.info({ expiresAt: request.expiresAt }, 'asked a person to approve a gated ops call');
    return await new Promise<ApprovalVerdict>((resolve) => {
      const finish = (verdict: ApprovalVerdict) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiting.delete(request.approvalId);
        resolve(verdict);
      };
      const onAbort = () => {
        log.info('run stopped while it waited for approval');
        finish(STOPPED);
      };
      const timer = setTimeout(() => {
        log.warn('no answer from the orchestrator by the deadline; counted as rejected');
        finish({ approved: false, reason: `no one decided within ${minutes(waitMs)}` });
      }, waitMs + this.graceMs);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(request.approvalId, { request, finish, log });
    });
  }

  private decided(approval: NodeDecision): void {
    const waiting = this.waiting.get(approval.id);
    if (waiting === undefined || waiting.request.runId !== approval.runId) {
      this.logger.info(
        { approvalId: approval.id, runId: approval.runId },
        'decision for an approval no run here is waiting on; ignored',
      );
      return;
    }
    waiting.log.info({ decision: approval.decision, decidedBy: approval.decidedBy }, 'decided');
    waiting.finish(verdictOf(approval));
  }

  private resend(): void {
    for (const { request, log } of this.waiting.values()) {
      log.info('asking again after the link reconnected');
      this.link.send('node.approval.request', request);
    }
  }
}

const STOPPED: ApprovalVerdict = {
  approved: false,
  reason: 'the run was stopped while it waited',
};

const minutes = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : `${Math.round(s / 60)} minutes`;
};

/** The answer in words the agent reads after "was not approved:". */
function verdictOf({ decision, decidedBy }: NodeDecision): ApprovalVerdict {
  if (decision === 'approved') return { approved: true, by: decidedBy };
  if (decidedBy === SYSTEM_DECIDERS.timedOut) {
    return { approved: false, reason: 'no one decided in time' };
  }
  if (decidedBy === SYSTEM_DECIDERS.runEnded) {
    return { approved: false, reason: 'the orchestrator says this run is no longer in progress' };
  }
  return { approved: false, reason: `${decidedBy.replace(/^ui:/, '')} rejected it` };
}

/**
 * What a person sees for `call`: its tool and arguments, as the step logs them. A rollback
 * also names the deployment it replaces and both builds, from the run's last plan, which
 * the call must match to run at all.
 */
export function approvalArgs(
  call: HostToolCall,
  ops: Pick<OpsHostTools, 'plannedRollback'> | undefined,
): Record<string, unknown> {
  const args: Record<string, unknown> = hostToolArgs(call);
  const plan = ops?.plannedRollback;
  if (call.tool !== 'ops.rollback' || plan == null) return args;
  return { ...args, from: plan.live.id, live: plan.live, rollBackTo: plan.rollBackTo };
}
