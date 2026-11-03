import type { Step } from '@page/contracts';

/** A `steps` row as execute() writes it. The database sets `createdAt`. */
export type StepEntry = Omit<Step, 'createdAt'>;

/** A step before the sink has numbered it. */
export type NewStep = Omit<StepEntry, 'seq'>;

/** How an opened step ended. `exitCode` is null for a timeout or a runner failure. */
export interface StepOutcome {
  outputTrimmed: string;
  exitCode: number | null;
}

/**
 * Where execute() records steps. Each call is one row, keyed by (runId, seq). An allowed
 * command is opened before it runs, so it is on record even if the daemon dies mid-run,
 * and closed with its outcome after. A refusal is opened already final and never closed.
 *
 * `open` picks the seq, one past the run's highest stored step, so a run resumed after a
 * restart carries on from where it was. Calls within one run are expected one at a time;
 * two opens racing for the same seq make one of them fail, and that call doesn't run.
 * Both methods reject when the write fails.
 */
export interface AuditSink {
  open(step: NewStep): Promise<number>;
  close(runId: string, seq: number, outcome: StepOutcome): Promise<void>;
}
