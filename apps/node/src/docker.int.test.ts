import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandboxes } from './docker-sandboxes.ts';

// The sandbox image's base. It has no /workspace, so this checks the container's
// lifecycle and limits, not commands; toolkit's DockerExecRunner test covers those.
const IMAGE = 'node:24-alpine';

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

const exists = (name: string) =>
  execFileSync('docker', ['ps', '--all', '--quiet', '--filter', `name=^${name}$`], {
    encoding: 'utf8',
  }).trim() !== '';

beforeAll(() => {
  execFileSync('docker', ['pull', '--quiet', IMAGE], { stdio: 'ignore' });
}, 120_000);

const sandboxes = new DockerSandboxes({ image: IMAGE });
const started: string[] = [];

afterAll(() => {
  for (const name of started) execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
});

describe('DockerSandboxes against Docker', () => {
  it('starts a locked-down container and removes it on stop', async () => {
    const sandbox = await sandboxes.start(randomUUID());
    started.push(sandbox.name);
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
