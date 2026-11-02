import type { AuditSink, StepEntry, StepOutcome } from './sink.ts';

/** An AuditSink for tests. Set `failOn` to make the next open or close reject. */
export class InMemoryAuditSink implements AuditSink {
  readonly steps: StepEntry[] = [];
  failOn: 'open' | 'close' | null = null;

  open(entry: StepEntry): Promise<void> {
    if (this.failOn === 'open') return Promise.reject(new Error('audit sink is down'));
    if (this.find(entry.runId, entry.seq)) {
      return Promise.reject(new Error(`step ${entry.runId}/${entry.seq} already exists`));
    }
    this.steps.push({ ...entry });
    return Promise.resolve();
  }

  close(runId: string, seq: number, outcome: StepOutcome): Promise<void> {
    if (this.failOn === 'close') return Promise.reject(new Error('audit sink is down'));
    const step = this.find(runId, seq);
    if (!step) return Promise.reject(new Error(`step ${runId}/${seq} was never opened`));
    Object.assign(step, outcome);
    return Promise.resolve();
  }

  private find(runId: string, seq: number): StepEntry | undefined {
    return this.steps.find((s) => s.runId === runId && s.seq === seq);
  }
}
