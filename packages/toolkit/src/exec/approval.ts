import type { Logger } from 'pino';
import type { Approve, ApprovalVerdict, ExecContext, HostToolCall, HostToolName } from './types.ts';

/**
 * The host tools a person approves, call by call, before they run: the Tier 3 tools that
 * change the live app. `ops.restart` drops requests in flight and loads any staged override,
 * and `ops.rollback` replaces the live build. `ops.setConfig` and `ops.deleteConfig` stage an
 * override that loads on the app's next restart of any kind (a crash, a redeploy, someone
 * else's restart), not only the run's own, so they are approved where the change is made,
 * with the key and value in view. The reads (`ops.getConfig`, `ops.planRollback`) and the
 * Tier 2 GitHub tools, which reach only the run's branch and PR, are not gated.
 */
export const APPROVAL_TOOLS: ReadonlySet<HostToolName> = new Set<HostToolName>([
  'ops.setConfig',
  'ops.deleteConfig',
  'ops.restart',
  'ops.rollback',
]);

export function needsApproval(tool: HostToolName): boolean {
  return APPROVAL_TOOLS.has(tool);
}

/**
 * Approves every call, as `by`. For runs no person watches and that change nothing shared:
 * the eval, whose live app is its own, and fake adapters. A daemon never uses it unless its
 * config says so.
 */
export function autoApprove(by: string): Approve {
  return () => Promise.resolve({ approved: true, by });
}

/** What the gate decided: run the tool with the time it has left, or refuse it. */
export type Gate = { refusal: string } | { timeoutMs: number };

/**
 * Holds a gated host tool call until a person approves it. The wait counts against the
 * call's time limit, so the tool gets what is left, and against the run's wall clock. A
 * rejection, no answer in time, a stopped run or a broken approver is a refusal: the call
 * doesn't run. Undefined for a call that needs no approval, and for one the host tools would
 * refuse anyway, which then refuses itself without anyone being asked.
 */
export async function approvalGate(
  call: HostToolCall,
  ctx: Pick<ExecContext, 'approve' | 'hostTools'>,
  timeoutMs: number,
  log: Logger,
  now: () => number = Date.now,
): Promise<Gate | undefined> {
  if (!needsApproval(call.tool) || ctx.hostTools?.refusal?.(call) != null) return undefined;
  // execute() refuses a gated call with no approver before it gets here.
  const approve = ctx.approve!;
  const started = now();
  let verdict: ApprovalVerdict;
  try {
    verdict = await approve(call, { timeoutMs });
  } catch (error) {
    log.error({ err: error, tool: call.tool }, 'asking for approval failed');
    return { refusal: `${call.tool} was not approved: asking for approval failed` };
  }
  if (!verdict.approved) {
    log.warn({ tool: call.tool, reason: verdict.reason }, 'not approved');
    return { refusal: `${call.tool} was not approved: ${verdict.reason}` };
  }
  log.info({ tool: call.tool, by: verdict.by }, 'approved');
  return { timeoutMs: Math.max(1, timeoutMs - (now() - started)) };
}
