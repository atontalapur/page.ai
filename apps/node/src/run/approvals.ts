import {
  autoApprove,
  hostToolArgs,
  type Approve,
  type HostToolCall,
  type OpsHostTools,
} from '@page/toolkit';

/** How a run asks a person to approve a gated host tool call (APPROVAL_TOOLS). */
export interface Approvals {
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
  return { forRun: () => autoApprove(by) };
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
