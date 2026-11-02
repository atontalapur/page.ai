import type { Tier } from '@page/contracts';
import type { StepLog } from '../audit/step-log.ts';
import type { Result } from '../result.ts';
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
  /** The run's audit trail. Every call writes one step to it. */
  steps: StepLog;
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

/** How a command that did run ended badly. */
export type RunErr = StepBase &
  ({ type: 'failed'; exitCode: number; output: string } | { type: 'timed_out'; output: string });

/** What running a command (or an edit) produced, before the audit log has its say. */
export type RunOutcome = Result<ExecOk, RunErr>;

export type ExecErr =
  | RunErr
  | (StepBase &
      // `auditFailed` is set when the refusal itself couldn't be written to the log.
      (
        | { type: 'refused'; message: string; auditFailed?: true }
        // The step couldn't be opened, so the command was stopped before it ran.
        | { type: 'audit_failed'; ran: false; message: string }
        // The command ran but its outcome couldn't be written. `result` is what it did.
        | { type: 'audit_failed'; ran: true; message: string; result: RunOutcome }
      ));
