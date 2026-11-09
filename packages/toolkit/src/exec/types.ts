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

/** Commits the agent's changes to the run's `pageagents/` branch on the demo repo. */
export interface PushBranchCall {
  kind: 'host_tool';
  tool: 'git.pushBranch';
  /** The commit message. */
  message: string;
}

/** Opens a PR from the run's branch, once it has been pushed. */
export interface OpenPrCall {
  kind: 'host_tool';
  tool: 'github.openPr';
  title: string;
  body: string;
}

/**
 * A tool the daemon runs on the host, not in the sandbox, because it needs the network or a
 * token. The tier policy decides which tiers may call each one.
 */
export type HostToolCall = PushBranchCall | OpenPrCall;

export type HostToolName = HostToolCall['tool'];

/** What a host tool did, in words the agent reads. */
export interface HostToolOutcome {
  ok: boolean;
  output: string;
}

/**
 * Runs host tools for one run. Resolves for anything the tool does, failures included;
 * rejects only when something is actually broken, which execute() treats like a runner crash.
 */
export interface HostTools {
  run(call: HostToolCall, timeoutMs: number): Promise<HostToolOutcome>;
}

export type ToolCall = ExecCall | EditCall | HostToolCall;

export interface ExecContext {
  tier: Tier;
  runner: ExecRunner;
  /** Tier 2 and up. Unset, every host tool call is refused. */
  hostTools?: HostTools;
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
