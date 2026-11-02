import type { Step } from '@page/contracts';

/** A `steps` row as execute() writes it. The database sets `createdAt`. */
export type StepEntry = Omit<Step, 'createdAt'>;

/** How an opened step ended. `exitCode` is null for a timeout or a runner failure. */
export interface StepOutcome {
  outputTrimmed: string;
  exitCode: number | null;
}

/**
 * Where execute() records steps. Each call is one row, keyed by (runId, seq). An allowed
 * command is opened before it runs, so it is on record even if the daemon dies mid-run,
 * and closed with its outcome after. A refusal is opened already final and never closed.
 * Both methods reject when the write fails.
 */
export interface AuditSink {
  open(entry: StepEntry): Promise<void>;
  close(runId: string, seq: number, outcome: StepOutcome): Promise<void>;
}
