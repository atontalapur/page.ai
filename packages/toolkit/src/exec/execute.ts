import type { StepOutcome } from '../audit/sink.ts';
import { writePathRefusal } from '../policy/paths.ts';
import { checkCommand, checkHostTool } from '../policy/policy.ts';
import { err, ok, type Result } from '../result.ts';
import { runEdit } from './edit.ts';
import { combineOutput, DEFAULT_OUTPUT_BUDGET, trimOutput } from './trim.ts';
import type {
  ExecCall,
  ExecContext,
  ExecErr,
  ExecOk,
  HostToolCall,
  HostTools,
  RunOutcome,
  StepBase,
  ToolCall,
} from './types.ts';

/** Under the sandbox's 15 minute wall clock, with room for a slow test run. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Characters of a command line that go into a log line. */
export const LOG_INPUT_BUDGET = 500;

type ExecResult = Result<ExecOk, ExecErr>;

/**
 * The one way the agent runs anything. A call is checked against the tier's policy
 * before the runner sees it; a refusal comes back as an error the agent can read, and the
 * runner is never called. Output is trimmed to the budget, keeping head and tail.
 *
 * Every call, refused or not, is one step in the audit log. An allowed call's step is
 * written before it runs, so if that write fails the call doesn't run at all. If the write
 * after it fails, the call returns `audit_failed` with what the command did in `result`.
 */
export async function execute(call: ToolCall, ctx: ExecContext): Promise<ExecResult> {
  const base = stepBase(call);
  const { steps } = ctx;
  const budget = ctx.outputBudget ?? DEFAULT_OUTPUT_BUDGET;
  const input = loggedInput(call);
  const step = { runId: steps.runId, kind: base.kind, input: base.input };
  let log = steps.logger.child({ tier: ctx.tier, kind: base.kind });

  const refusal = refusalFor(call, ctx);
  if (refusal !== null) {
    const message = `refused: ${refusal}`;
    const refused = { ...base, type: 'refused' as const, message };
    try {
      const seq = await steps.sink.open({
        ...step,
        outputTrimmed: message,
        exitCode: null,
        allowed: false,
      });
      log.warn({ seq, input }, message);
      return err(refused);
    } catch (error) {
      // Still a refusal: the agent should see why, not a write failure it might retry.
      log.error({ err: error, input }, `audit write failed; ${message}`);
      return err({ ...refused, auditFailed: true });
    }
  }

  let seq: number;
  try {
    seq = await steps.sink.open({ ...step, outputTrimmed: '', exitCode: null, allowed: true });
  } catch (error) {
    log.error({ err: error, input }, 'audit write failed');
    const message = 'audit log write failed, so the command was not run';
    return err({ ...base, type: 'audit_failed', ran: false, message });
  }
  log = log.child({ seq });
  log.info({ input }, 'running');

  let result: RunOutcome;
  try {
    result = await run(call, ctx, base);
  } catch (error) {
    // The runner itself broke. Close the step so it doesn't read as still running.
    const outcome = {
      outputTrimmed: trimOutput(`runner error: ${String(error)}`, budget),
      exitCode: null,
    };
    await steps.sink.close(steps.runId, seq, outcome).catch((closeError: unknown) => {
      log.error({ err: closeError }, 'audit write failed');
    });
    log.error({ err: error }, 'runner failed');
    throw error;
  }

  const outcome = outcomeOf(result);
  try {
    await steps.sink.close(steps.runId, seq, outcome);
  } catch (error) {
    log.error({ err: error, exitCode: outcome.exitCode }, 'audit write failed');
    const message = 'audit log write failed after the command ran; its outcome is not on record';
    return err({ ...base, type: 'audit_failed', ran: true, message, result });
  }
  log.info(
    { ok: result.ok, exitCode: outcome.exitCode },
    result.ok ? 'succeeded' : `failed: ${result.error.type}`,
  );
  return result;
}

function run(call: ToolCall, ctx: ExecContext, base: StepBase): Promise<RunOutcome> {
  switch (call.kind) {
    case 'edit':
      return runEdit(call, ctx, base);
    case 'host_tool':
      // refusalFor has made sure the host tools are there.
      return runHostTool(call, ctx, ctx.hostTools!, base);
    case 'exec':
      return runExec(call, ctx, base);
  }
}

/**
 * A host tool call's tool and arguments, without the `kind` every one of them shares. This
 * is the step's input, so replay and test helpers build it here too.
 */
export function hostToolArgs(call: HostToolCall): Record<string, string> {
  return call.tool === 'git.pushBranch'
    ? { tool: call.tool, message: call.message }
    : { tool: call.tool, title: call.title, body: call.body };
}

function stepBase(call: ToolCall): StepBase {
  if (call.kind === 'host_tool') {
    return { kind: 'host_tool', input: JSON.stringify(hostToolArgs(call)) };
  }
  if (call.kind === 'edit') {
    const { path, oldText, newText } = call;
    return { kind: 'edit', input: JSON.stringify({ path, oldText, newText }) };
  }
  return { kind: 'exec', input: call.command };
}

/**
 * The input as it goes into a log line. The steps row keeps it whole; logs get a trimmed
 * command, and an edit's path and text lengths but not the text, which may hold secrets.
 */
function loggedInput(call: ToolCall): string | Record<string, unknown> {
  if (call.kind === 'host_tool') {
    // The tool and how much text it carries; the text itself is in the steps row.
    const sizes = Object.entries(hostToolArgs(call))
      .filter(([key]) => key !== 'tool')
      .map(([key, value]): [string, number] => [`${key}Length`, value.length]);
    return { tool: call.tool, ...Object.fromEntries(sizes) };
  }
  if (call.kind === 'edit') {
    return {
      path: call.path,
      oldTextLength: call.oldText.length,
      newTextLength: call.newText.length,
    };
  }
  return trimOutput(call.command, LOG_INPUT_BUDGET);
}

function refusalFor(call: ToolCall, { tier, hostTools }: ExecContext): string | null {
  if (call.kind === 'edit') return writePathRefusal(call.path);
  const verdict =
    call.kind === 'host_tool' ? checkHostTool(call.tool, tier) : checkCommand(call.command, tier);
  if (!verdict.allowed) return verdict.reason;
  if (call.kind === 'host_tool' && hostTools === undefined) {
    return `${call.tool} is not set up on this node`;
  }
  return null;
}

/** What goes in the step's output and exit code columns. */
function outcomeOf(result: RunOutcome): StepOutcome {
  if (result.ok) return { outputTrimmed: result.value.output, exitCode: 0 };
  const { error } = result;
  return { outputTrimmed: error.output, exitCode: error.type === 'failed' ? error.exitCode : null };
}

async function runExec(call: ExecCall, ctx: ExecContext, base: StepBase): Promise<RunOutcome> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await ctx.runner.run({ command: call.command, timeoutMs });
  const output = trimOutput(
    combineOutput(result.stdout, result.stderr),
    ctx.outputBudget ?? DEFAULT_OUTPUT_BUDGET,
  );

  if (result.status === 'timed_out') {
    return err({
      ...base,
      type: 'timed_out',
      output: `${output}${output === '' ? '' : '\n'}[timed out after ${timeoutMs} ms]`,
    });
  }
  if (result.exitCode !== 0) {
    return err({ ...base, type: 'failed', exitCode: result.exitCode, output });
  }
  return ok({ ...base, exitCode: 0, output });
}

async function runHostTool(
  call: HostToolCall,
  ctx: ExecContext,
  hostTools: HostTools,
  base: StepBase,
): Promise<RunOutcome> {
  const result = await hostTools.run(call, ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const output = trimOutput(result.output, ctx.outputBudget ?? DEFAULT_OUTPUT_BUDGET);
  if (result.ok) return ok({ ...base, exitCode: 0, output });
  return err({ ...base, type: 'failed', exitCode: 1, output });
}
