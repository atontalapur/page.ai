import type { Tier } from '@page/contracts';
import type { ExecRunner } from './runner.ts';

/** A shell command, checked against the tier's policy. */
export interface ExecCall {
  kind: 'exec';
  command: string;
}

/**
 * Replaces the one place `oldText` appears in `path` with `newText`. An empty `oldText`
 * creates `path`, which must not exist yet.
 */
export interface EditCall {
  kind: 'edit';
  path: string;
  oldText: string;
  newText: string;
}

export type ToolCall = ExecCall | EditCall;

export interface ExecContext {
  tier: Tier;
  runner: ExecRunner;
  timeoutMs?: number;
  /** Characters of output the agent sees; see trimOutput. */
  outputBudget?: number;
}

export interface StepBase {
  kind: ToolCall['kind'];
  /** What the agent asked for: the command line, or the edit as JSON. */
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
