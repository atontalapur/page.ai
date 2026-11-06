import type { Step } from '@page/contracts';
import type { AuditSink, NewStep, StepOutcome } from '@page/toolkit';
import type { Logger } from 'pino';

/**
 * Wraps the steps table's sink and passes each step on once it is final: a refusal when
 * it is opened, an allowed call when it is closed with its outcome. The inner sink is the
 * record and goes first; if it fails, nothing is streamed and execute() sees the failure.
 *
 * `createdAt` is the daemon's clock. The row's own timestamp comes from the database, so
 * the two can differ by the write's latency.
 */
export class StreamingAuditSink implements AuditSink {
  private readonly inner: AuditSink;
  private readonly onStep: (step: Step) => void;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly open_ = new Map<string, Step>();

  constructor(options: {
    inner: AuditSink;
    onStep: (step: Step) => void;
    logger: Logger;
    now?: () => Date;
  }) {
    this.inner = options.inner;
    this.onStep = options.onStep;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  async open(step: NewStep): Promise<number> {
    const seq = await this.inner.open(step);
    const entry = { ...step, seq, createdAt: this.now().toISOString() };
    if (step.allowed) this.open_.set(key(step.runId, seq), entry);
    else this.emit(entry);
    return seq;
  }

  async close(runId: string, seq: number, outcome: StepOutcome): Promise<void> {
    await this.inner.close(runId, seq, outcome);
    const entry = this.open_.get(key(runId, seq));
    this.open_.delete(key(runId, seq));
    if (entry !== undefined) this.emit({ ...entry, ...outcome });
  }

  /** A step that can't be streamed is still on record, so the run carries on. */
  private emit(step: Step): void {
    try {
      this.onStep(step);
    } catch (error) {
      this.logger.error({ err: error, seq: step.seq }, 'could not stream step');
    }
  }
}

const key = (runId: string, seq: number) => `${runId}/${seq}`;
