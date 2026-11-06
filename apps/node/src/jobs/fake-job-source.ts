import type { ClaimedJob, FixJob, FixJobHandler, JobSource } from './job-source.ts';

/** A JobSource for tests. `deliver` hands a job to the handler as a claim would. */
export class FakeJobSource implements JobSource {
  private handler: FixJobHandler | null = null;
  stopped = false;

  start(handler: FixJobHandler): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.handler = null;
    return Promise.resolve();
  }

  /** Resolves or rejects as the handler does. */
  deliver(job: FixJob, options: Partial<Omit<ClaimedJob, 'job'>> = {}): Promise<void> {
    if (this.handler === null) throw new Error('FakeJobSource is not started');
    const { signal = new AbortController().signal, attempt = 0 } = options;
    return this.handler({ job, signal, attempt });
  }
}
