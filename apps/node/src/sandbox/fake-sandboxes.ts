import { FakeRunner, type RunRequest, type RunResult } from '@page/toolkit';
import { sandboxName, type Sandbox, type Sandboxes } from './sandbox.ts';

type Responder = (request: RunRequest) => RunResult | Promise<RunResult>;

/**
 * Sandboxes for tests and USE_FAKE_ADAPTERS. Each sandbox gets a FakeRunner that answers
 * with `respond`. Records which runs started and stopped; set `failStart` to make the next
 * start reject the way a missing image would.
 */
export class FakeSandboxes implements Sandboxes {
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly runners = new Map<string, FakeRunner>();
  failStart = false;
  private readonly respond: Responder | undefined;

  constructor(respond?: Responder) {
    this.respond = respond;
  }

  /** Containers started and not yet stopped. */
  get running(): string[] {
    return this.started.filter((name) => !this.stopped.includes(name));
  }

  start(runId: string): Promise<Sandbox> {
    const name = sandboxName(runId);
    if (this.failStart) {
      this.failStart = false;
      return Promise.reject(new Error(`could not start sandbox ${name}: image not found`));
    }
    const runner = new FakeRunner(this.respond);
    this.started.push(name);
    this.runners.set(name, runner);
    return Promise.resolve({ name, runner });
  }

  stop({ name }: Sandbox): Promise<void> {
    if (!this.stopped.includes(name)) this.stopped.push(name);
    return Promise.resolve();
  }
}
