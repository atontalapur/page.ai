import { pino, type Logger } from 'pino';
import type { AuditSink } from './sink.ts';

export interface StepLogOptions {
  sink: AuditSink;
  issueId: string;
  runId: string;
  /** Defaults to a silent logger. */
  logger?: Logger;
}

/**
 * One run's audit trail: where its steps go and a logger bound to the issue and run. The
 * sink numbers the steps. execute() adds the tier, so every line carries all three.
 */
export class StepLog {
  readonly sink: AuditSink;
  readonly issueId: string;
  readonly runId: string;
  readonly logger: Logger;

  constructor(options: StepLogOptions) {
    this.sink = options.sink;
    this.issueId = options.issueId;
    this.runId = options.runId;
    this.logger = (options.logger ?? pino({ enabled: false })).child({
      issueId: options.issueId,
      runId: options.runId,
    });
  }
}
