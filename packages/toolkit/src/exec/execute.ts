import type { Tier } from '@page/contracts';
import { checkCommand } from '../policy/policy.ts';
import { err, ok, type Result } from '../result.ts';
import type { ExecRunner } from './runner.ts';
import { combineOutput, DEFAULT_OUTPUT_BUDGET, trimOutput } from './trim.ts';

/** Under the sandbox's 15 minute wall clock, with room for a slow test run. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export type ToolCall = { kind: 'exec'; command: string };

export interface ExecContext {
  tier: Tier;
  runner: ExecRunner;
  timeoutMs?: number;
  /** Characters of output the agent sees; see trimOutput. */
  outputBudget?: number;
}

interface StepBase {
  kind: ToolCall['kind'];
  /** What the agent asked to run, as it asked. */
  input: string;
}

export interface ExecOk extends StepBase {
  exitCode: 0;
  output: string;
}

export type ExecErr = StepBase &
  (
    | { type: 'refused'; message: string }
    | { type: 'failed'; exitCode: number; output: string }
    | { type: 'timed_out'; output: string }
  );

/**
 * The one way the agent runs anything. The command is checked against the tier's policy
 * before the runner sees it; a refusal comes back as an error the agent can read, and the
 * runner is never called. Output is trimmed to the budget, keeping head and tail.
 */
export async function execute(call: ToolCall, ctx: ExecContext): Promise<Result<ExecOk, ExecErr>> {
  const base: StepBase = { kind: call.kind, input: call.command };

  const verdict = checkCommand(call.command, ctx.tier);
  if (!verdict.allowed) {
    return err({ ...base, type: 'refused', message: `refused: ${verdict.reason}` });
  }

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
