import { pino, type Logger } from 'pino';
import type { AuditSink } from './sink.ts';

export interface StepLogOptions {
  sink: AuditSink;
  issueId: string;
  runId: string;
  /** Where numbering starts, for a run that already has steps. */
  firstSeq?: number;
  /** Defaults to a silent logger. */
  logger?: Logger;
}

/**
 * One run's audit trail: where its steps go, the next seq, and a logger bound to the
 * issue and run. execute() adds the tier, so every line carries all three.
 */
export class StepLog {
  readonly sink: AuditSink;
  readonly issueId: string;
  readonly runId: string;
  readonly logger: Logger;
  private seq: number;

  constructor(options: StepLogOptions) {
    this.sink = options.sink;
    this.issueId = options.issueId;
    this.runId = options.runId;
    this.seq = options.firstSeq ?? 0;
    this.logger = (options.logger ?? pino({ enabled: false })).child({
      issueId: options.issueId,
      runId: options.runId,
    });
  }

  /** Claims the next seq. A seq is used once, even when its write fails. */
  next(): number {
    const seq = this.seq;
    this.seq += 1;
    return seq;
  }
}
