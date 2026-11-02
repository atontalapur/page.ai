import type { Tier } from '@page/contracts';
import type { Logger } from 'pino';
import type { StepOutcome } from '../audit/sink.ts';
import { writePathRefusal } from '../policy/paths.ts';
import { checkCommand } from '../policy/policy.ts';
import { err, ok, type Result } from '../result.ts';
import { runEdit } from './edit.ts';
import { combineOutput, DEFAULT_OUTPUT_BUDGET, trimOutput } from './trim.ts';
import type { ExecCall, ExecContext, ExecErr, ExecOk, StepBase, ToolCall } from './types.ts';

/** Under the sandbox's 15 minute wall clock, with room for a slow test run. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

type ExecResult = Result<ExecOk, ExecErr>;

/**
 * The one way the agent runs anything. A call is checked against the tier's policy
 * before the runner sees it; a refusal comes back as an error the agent can read, and the
 * runner is never called. Output is trimmed to the budget, keeping head and tail.
 *
 * Every call, refused or not, is one step in the audit log. An allowed call's step is
 * written before it runs, so if that write fails the call doesn't run at all.
 */
export async function execute(call: ToolCall, ctx: ExecContext): Promise<ExecResult> {
  const base = stepBase(call);
  const { steps } = ctx;
  const seq = steps.next();
  const log = steps.logger.child({ tier: ctx.tier, seq, kind: base.kind });
  const entry = { runId: steps.runId, seq, kind: base.kind, input: base.input };

  const refusal = refusalFor(call, ctx.tier);
  if (refusal !== null) {
    const message = `refused: ${refusal}`;
    const failed = await audit(base, log, false, () =>
      steps.sink.open({ ...entry, outputTrimmed: message, exitCode: null, allowed: false }),
    );
    if (failed) return failed;
    log.warn({ input: base.input }, message);
    return err({ ...base, type: 'refused', message });
  }

  const notOpened = await audit(base, log, false, () =>
    steps.sink.open({ ...entry, outputTrimmed: '', exitCode: null, allowed: true }),
  );
  if (notOpened) return notOpened;
  log.info({ input: base.input }, 'running');

  let result: ExecResult;
  try {
    result = call.kind === 'edit' ? await runEdit(call, ctx, base) : await runExec(call, ctx, base);
  } catch (error) {
    // The runner itself broke. Close the step so it doesn't read as still running.
    const outcome = { outputTrimmed: `runner error: ${String(error)}`, exitCode: null };
    await steps.sink.close(steps.runId, seq, outcome).catch((closeError: unknown) => {
      log.error({ err: closeError }, 'audit write failed');
    });
    log.error({ err: error }, 'runner failed');
    throw error;
  }

  const notClosed = await audit(base, log, true, () =>
    steps.sink.close(steps.runId, seq, outcomeOf(result)),
  );
  if (notClosed) return notClosed;
  log.info(
    { ok: result.ok, exitCode: result.ok ? 0 : outcomeOf(result).exitCode },
    result.ok ? 'succeeded' : `failed: ${result.error.type}`,
  );
  return result;
}

function stepBase(call: ToolCall): StepBase {
  if (call.kind === 'edit') {
    const { path, oldText, newText } = call;
    return { kind: 'edit', input: JSON.stringify({ path, oldText, newText }) };
  }
  return { kind: 'exec', input: call.command };
}

function refusalFor(call: ToolCall, tier: Tier): string | null {
  if (call.kind === 'edit') return writePathRefusal(call.path);
  const verdict = checkCommand(call.command, tier);
  return verdict.allowed ? null : verdict.reason;
}

/** What goes in the step's output and exit code columns. */
function outcomeOf(result: ExecResult): StepOutcome {
  if (result.ok) return { outputTrimmed: result.value.output, exitCode: 0 };
  const { error } = result;
  switch (error.type) {
    case 'failed':
      return { outputTrimmed: error.output, exitCode: error.exitCode };
    case 'timed_out':
      return { outputTrimmed: error.output, exitCode: null };
    case 'refused':
    case 'audit_failed':
      return { outputTrimmed: error.message, exitCode: null };
  }
}

/** Runs one audit write. A failure becomes the call's result, so it is never silent. */
async function audit(
  base: StepBase,
  log: Logger,
  ran: boolean,
  write: () => Promise<void>,
): Promise<ExecResult | null> {
  try {
    await write();
    return null;
  } catch (error) {
    log.error({ err: error, input: base.input }, 'audit write failed');
    const message = ran
      ? 'audit log write failed after the command ran; its outcome is not on record'
      : 'audit log write failed, so the command was not run';
    return err({ ...base, type: 'audit_failed', ran, message });
  }
}

async function runExec(call: ExecCall, ctx: ExecContext, base: StepBase): Promise<ExecResult> {
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
