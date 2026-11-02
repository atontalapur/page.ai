import type { AuditSink, NewStep, StepEntry, StepOutcome } from './sink.ts';

/** An AuditSink for tests. Set `failOn` to make the next open or close reject. */
export class InMemoryAuditSink implements AuditSink {
  readonly steps: StepEntry[] = [];
  failOn: 'open' | 'close' | null = null;

  open(step: NewStep): Promise<number> {
    if (this.failOn === 'open') return Promise.reject(new Error('audit sink is down'));
    const taken = this.steps.filter((s) => s.runId === step.runId).map((s) => s.seq);
    const seq = taken.length === 0 ? 0 : Math.max(...taken) + 1;
    this.steps.push({ ...step, seq });
    return Promise.resolve(seq);
  }

  close(runId: string, seq: number, outcome: StepOutcome): Promise<void> {
    if (this.failOn === 'close') return Promise.reject(new Error('audit sink is down'));
    const step = this.steps.find((s) => s.runId === runId && s.seq === seq);
    if (!step) return Promise.reject(new Error(`step ${runId}/${seq} was never opened`));
    Object.assign(step, outcome);
    return Promise.resolve();
  }
}
