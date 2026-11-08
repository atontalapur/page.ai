import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeRunner } from '@page/toolkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerSandboxes } from './docker-sandboxes.ts';
import { sandboxRunArgs } from './run-args.ts';

// Records its argv; see the script for the failures it fakes.
const docker = fileURLToPath(new URL('./__fixtures__/fake-docker.sh', import.meta.url));
const runId = '7c1e4a2b-5d3f-4b8a-a1c9-6e2f8d4b3a02';

let dir = '';
let log = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  log = join(dir, 'argv');
  process.env.FAKE_DOCKER_LOG = log;
});

afterEach(() => {
  delete process.env.FAKE_DOCKER_LOG;
  delete process.env.FAKE_DOCKER_PS;
  rmSync(dir, { recursive: true, force: true });
});

/** Each docker call's argv, in order. */
const calls = () =>
  readFileSync(log, 'utf8')
    .split('\n\n')
    .filter(Boolean)
    .map((call) => call.split('\n'));

// Each test spawns the stand-in, which takes 15-70ms alone but seconds once turbo runs every
// package's tests at once. Under the 5s default that timed out locally.
describe('DockerSandboxes', { timeout: 20_000 }, () => {
  it('starts one container per run under the sandbox limits, named for the run', async () => {
    const sandboxes = new DockerSandboxes({ image: 'page-sandbox', docker });
    const sandbox = await sandboxes.start(runId);
    expect(sandbox.name).toBe(`pageagents-${runId}`);
    expect(calls()).toEqual([sandboxRunArgs({ image: 'page-sandbox', name: sandbox.name })]);
  });

  it('removes the container on stop', async () => {
    const sandboxes = new DockerSandboxes({ image: 'page-sandbox', docker });
    await sandboxes.stop(await sandboxes.start(runId));
    expect(calls()[1]).toEqual(['rm', '--force', `pageagents-${runId}`]);
  });

  it('sends commands into the container with docker exec', async () => {
    const sandbox = await new DockerSandboxes({ image: 'page-sandbox', docker }).start(runId);
    await sandbox.runner.run({ command: 'ls', timeoutMs: 1000 });
    const exec = calls()[1]!;
    expect(exec[0]).toBe('exec');
    expect(exec).toContain(`pageagents-${runId}`);
  });

  it('rejects with docker’s error when the container cannot start', async () => {
    const sandboxes = new DockerSandboxes({ image: 'missing', docker });
    await expect(sandboxes.start(runId)).rejects.toThrow(
      `could not start sandbox pageagents-${runId}: Unable to find image 'missing:latest'`,
    );
  });

  it('treats a container that is already gone as stopped', async () => {
    const sandboxes = new DockerSandboxes({ image: 'page-sandbox', docker });
    await expect(
      sandboxes.stop({ name: 'pageagents-gone', runner: new FakeRunner() }),
    ).resolves.toBe(undefined);
  });

  it('rejects when docker cannot remove the container', async () => {
    const sandboxes = new DockerSandboxes({ image: 'page-sandbox', docker });
    await expect(
      sandboxes.stop({ name: 'pageagents-down', runner: new FakeRunner() }),
    ).rejects.toThrow(
      'could not stop sandbox pageagents-down: Cannot connect to the Docker daemon',
    );
  });

  it('reaps every leftover sandbox container and nothing else', async () => {
    process.env.FAKE_DOCKER_PS = `pageagents-a\nsomething-else\npageagents-b\n`;
    const sandboxes = new DockerSandboxes({ image: 'page-sandbox', docker });
    expect(await sandboxes.reap()).toEqual(['pageagents-a', 'pageagents-b']);
    expect(calls()).toEqual([
      ['ps', '--all', '--filter', 'label=page.sandbox=1', '--format', '{{.Names}}'],
      ['rm', '--force', 'pageagents-a'],
      ['rm', '--force', 'pageagents-b'],
    ]);
  });

  it('reaps nothing when there are no leftovers', async () => {
    const sandboxes = new DockerSandboxes({ image: 'page-sandbox', docker });
    expect(await sandboxes.reap()).toEqual([]);
    expect(calls()).toHaveLength(1);
  });

  it('rejects when docker cannot list containers', async () => {
    process.env.FAKE_DOCKER_PS = 'down';
    const sandboxes = new DockerSandboxes({ image: 'page-sandbox', docker });
    await expect(sandboxes.reap()).rejects.toThrow(
      'could not list sandboxes: Cannot connect to the Docker daemon',
    );
  });

  it('reports a docker binary that is not there', async () => {
    const sandboxes = new DockerSandboxes({ image: 'page-sandbox', docker: join(dir, 'nope') });
    await expect(sandboxes.start(runId)).rejects.toThrow(/could not start sandbox .*ENOENT/);
  });
});
