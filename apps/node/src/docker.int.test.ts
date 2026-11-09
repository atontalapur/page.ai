import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { jobFixtures } from '@page/contracts/fixtures';
import type { CompleteOptions, CompletionResult, ModelClient } from '@page/model-client';
import { InMemoryAuditSink } from '@page/toolkit';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeLink } from './link/fake-link.ts';
import { bashReply } from './model/scripted-model.ts';
import { DockerSandboxes } from './sandbox/docker-sandboxes.ts';
import { sandboxName } from './sandbox/sandbox.ts';
import { runFixJob } from './run/run-fix-job.ts';

// Every node test that touches Docker lives in this one file. Vitest runs files in
// parallel, and reaping removes every sandbox on the host, so it would remove another
// file's containers mid-test.

// The sandbox image's base; the integration job doesn't build page-sandbox. It has no
// /workspace, so the kill tests' sandboxes get one (and a file to tail) as they start.
const IMAGE = 'node:24-alpine';
// #9: a kill completes within 5 s.
const KILL_BUDGET_MS = 5_000;

interface Inspected {
  State: { Running: boolean };
  HostConfig: { NetworkMode: string; Memory: number; MemorySwap: number; PidsLimit: number };
}

const inspect = (name: string) => {
  const [container] = JSON.parse(
    execFileSync('docker', ['inspect', name], { encoding: 'utf8' }),
  ) as Inspected[];
  return container!;
};

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });
const exists = (name: string) =>
  docker('ps', '--all', '--quiet', '--filter', `name=^${name}$`).trim() !== '';

beforeAll(() => {
  execFileSync('docker', ['pull', '--quiet', IMAGE], { stdio: 'ignore' });
}, 120_000);

const names: string[] = [];
afterAll(() => {
  for (const name of names) execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
});

const sandboxes = new DockerSandboxes({ image: IMAGE });

/** Real Docker sandboxes, with /workspace made after each one starts. */
class WorkspaceSandboxes extends DockerSandboxes {
  override async start(runId: string) {
    const sandbox = await super.start(runId);
    names.push(sandbox.name);
    docker('exec', sandbox.name, 'sh', '-c', 'mkdir -p /workspace && touch /workspace/app.log');
    return sandbox;
  }
}

/** Answers with `replies` in order; once they run out, hangs until its call is cancelled. */
function model(replies: string[]) {
  let calls = 0;
  const client: ModelClient = {
    complete(_messages, options?: CompleteOptions) {
      calls += 1;
      const content = replies.shift();
      if (content !== undefined) {
        return Promise.resolve({
          ok: true,
          completion: { content, finishReason: 'stop', model: 'scripted', costUsd: 0 },
        });
      }
      return new Promise<CompletionResult>((resolve) => {
        const cancelled = () =>
          resolve({ ok: false, error: { kind: 'aborted', status: null, message: 'cancelled' } });
        if (options?.signal?.aborted) cancelled();
        else options?.signal?.addEventListener('abort', cancelled);
      });
    },
  };
  return { client, calls: () => calls };
}

/** Starts a run, kills it once `ready` holds, and times the kill. */
async function killRun(replies: string[], ready: (calls: number) => boolean) {
  const job = { ...jobFixtures.fix, runId: randomUUID() };
  const name = sandboxName(job.runId);
  const m = model(replies);
  const link = new FakeLink();
  const kill = new AbortController();
  const run = runFixJob(
    { job, signal: new AbortController().signal, attempt: 0 },
    {
      sandboxes: new WorkspaceSandboxes({ image: IMAGE }),
      sink: new InMemoryAuditSink(),
      link,
      model: m.client,
      logger: pino({ enabled: false }),
    },
    kill.signal,
  );

  await expect.poll(() => exists(name) && ready(m.calls()), { timeout: 15_000 }).toBe(true);
  // Give a running command time to be well under way.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const killedAt = Date.now();
  kill.abort();
  const finished = await run;
  return { finished, elapsed: Date.now() - killedAt, name, link };
}

describe('DockerSandboxes against Docker', () => {
  it('starts a locked-down container and removes it on stop', async () => {
    const sandbox = await sandboxes.start(randomUUID());
    names.push(sandbox.name);
    const { State, HostConfig } = inspect(sandbox.name);
    expect(State.Running).toBe(true);
    expect(HostConfig).toMatchObject({
      NetworkMode: 'none',
      Memory: 1024 ** 3,
      MemorySwap: 1024 ** 3,
      PidsLimit: 256,
    });

    await sandboxes.stop(sandbox);
    expect(exists(sandbox.name)).toBe(false);
    // Stopping twice is fine: cleanup runs on every exit path.
    await expect(sandboxes.stop(sandbox)).resolves.toBe(undefined);
  }, 20_000);

  it('rejects when the image does not exist', async () => {
    const missing = new DockerSandboxes({ image: `page-missing-${randomUUID()}` });
    await expect(missing.start(randomUUID())).rejects.toThrow(/could not start sandbox/);
  }, 20_000);
});

describe('killing a run against Docker', () => {
  it('stops a command that would never end and leaves no container', async () => {
    const { finished, elapsed, name, link } = await killRun(
      [bashReply('tail -f app.log')],
      (calls) => calls >= 1,
    );
    expect(finished).toMatchObject({ status: 'killed' });
    expect(link.payloads('node.run.finished')).toEqual([finished]);
    expect(elapsed).toBeLessThan(KILL_BUDGET_MS);
    expect(exists(name)).toBe(false);
  }, 30_000);

  it('cancels a model call in flight and leaves no container', async () => {
    const { finished, elapsed, name } = await killRun([], (calls) => calls >= 1);
    expect(finished).toMatchObject({ status: 'killed' });
    expect(elapsed).toBeLessThan(KILL_BUDGET_MS);
    expect(exists(name)).toBe(false);
  }, 30_000);
});

describe('reaping against Docker', () => {
  it('removes a sandbox a previous daemon left behind', async () => {
    const left = await new DockerSandboxes({ image: IMAGE }).start(randomUUID());
    names.push(left.name);
    const { removed } = await new DockerSandboxes({ image: IMAGE }).reap();
    expect(removed).toContain(left.name);
    expect(exists(left.name)).toBe(false);
  }, 30_000);
});
