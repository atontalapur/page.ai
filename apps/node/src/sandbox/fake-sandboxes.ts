import { FakeRunner, SAFE_GIT, type RunRequest, type RunResult } from '@page/toolkit';
import { sandboxName, type Reaped, type Sandbox, type Sandboxes } from './sandbox.ts';

type Responder = (request: RunRequest) => RunResult | Promise<RunResult>;

const FAKE_FIX = 'apps/demo-app/src/shop/money.ts';
const FAKE_DIFF = [
  `diff --git a/${FAKE_FIX} b/${FAKE_FIX}`,
  `--- a/${FAKE_FIX}`,
  `+++ b/${FAKE_FIX}`,
  '@@ -1 +1 @@',
  "-const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'US' });",
  "+const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });",
  '',
].join('\n');

/**
 * The workspace USE_FAKE_ADAPTERS runs in: one changed file, which `git status` and `git
 * diff` show, so a fake run that tests and submits scores as a fix. Every other command exits
 * 0 with no output.
 */
export const fakeWorkspace: Responder = ({ command }) => {
  if (command.startsWith(`${SAFE_GIT} status`)) return FakeRunner.exited(0, ` M ${FAKE_FIX}\0`);
  if (command.startsWith(`${SAFE_GIT} diff`)) return FakeRunner.exited(0, FAKE_DIFF);
  return FakeRunner.exited(0);
};

/**
 * Sandboxes for tests and USE_FAKE_ADAPTERS. Each sandbox gets a FakeRunner that answers
 * with `respond`. Records which runs started and stopped; set `failStart` to make the next
 * start reject the way a missing image would. `strays` plays containers a previous daemon
 * left behind, for `reap` to find.
 */
export class FakeSandboxes implements Sandboxes {
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly runners = new Map<string, FakeRunner>();
  failStart = false;
  strays: string[] = [];
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

  reap(): Promise<Reaped> {
    const removed = [...this.strays, ...this.running];
    this.strays = [];
    for (const name of removed) if (!this.stopped.includes(name)) this.stopped.push(name);
    return Promise.resolve({ removed, failed: [] });
  }
}
