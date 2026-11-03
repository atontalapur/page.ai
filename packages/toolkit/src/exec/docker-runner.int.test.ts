import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSteps } from '../audit/test-utils.ts';
import { execute } from './execute.ts';
import { DockerExecRunner } from './docker-runner.ts';

// The sandbox image's base: same busybox `timeout` and `sh`, without building the image.
// Started with the sandbox's network and privilege limits.
const IMAGE = 'node:24-alpine';

let container = '';

beforeAll(() => {
  execFileSync('docker', ['pull', '--quiet', IMAGE], { stdio: 'ignore' });
  container = execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      // tini as PID 1, as in the sandbox image.
      '--init',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      'node',
      // Writable by the node user, as /workspace is in the sandbox image.
      '--tmpfs',
      '/workspace:uid=1000,gid=1000',
      '--workdir',
      '/workspace',
      IMAGE,
      'sleep',
      '300',
    ],
    { encoding: 'utf8' },
  ).trim();
}, 120_000);

afterAll(() => {
  if (container) execFileSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
});

describe('DockerExecRunner against a container', () => {
  it('runs in the workspace and returns output and exit code', async () => {
    const runner = new DockerExecRunner({ container });
    const result = await runner.run({ command: 'pwd; echo err >&2; exit 4', timeoutMs: 10_000 });
    expect(result).toEqual({
      status: 'exited',
      exitCode: 4,
      stdout: '/workspace\n',
      stderr: 'err\n',
    });
  });

  it('passes stdin through', async () => {
    const runner = new DockerExecRunner({ container });
    const result = await runner.run({ command: 'cat', timeoutMs: 10_000, stdin: 'a\nb' });
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, stdout: 'a\nb' });
  });

  it('times out and kills the command inside the container', async () => {
    const runner = new DockerExecRunner({ container });
    // Compound, so the sleep is a grandchild that `timeout` alone would leave running.
    const result = await runner.run({ command: 'sleep 37; true', timeoutMs: 1000 });
    expect(result.status).toBe('timed_out');
    const ps = await runner.run({ command: 'ps -o args', timeoutMs: 10_000 });
    expect(ps.stdout).not.toContain('sleep 37');
    // The container itself survives the cleanup.
    expect(ps.stdout).toContain('sleep 300');
  }, 20_000);

  it('kills what a finished command left behind, even with a fresh env or session', async () => {
    const runner = new DockerExecRunner({ container });
    // Both hold stdout open. One drops the tag (like a worker spawned with its own env),
    // the other leaves the session.
    const result = await runner.run({
      command: 'env -i sleep 41 & setsid sleep 43 & echo ok',
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ status: 'exited', exitCode: 0, stdout: 'ok\n', stderr: '' });
    const ps = await runner.run({ command: 'ps -o args', timeoutMs: 10_000 });
    expect(ps.stdout).not.toContain('sleep 41');
    expect(ps.stdout).not.toContain('sleep 43');
    expect(ps.stdout).toContain('sleep 300');
  }, 20_000);

  it('rejects when the container does not exist', async () => {
    const runner = new DockerExecRunner({ container: 'page-no-such-container' });
    await expect(runner.run({ command: 'ls', timeoutMs: 5000 })).rejects.toThrow(
      'No such container',
    );
  });

  it('is what execute() drives end to end', async () => {
    const runner = new DockerExecRunner({ container });
    const result = await execute(
      { kind: 'exec', command: 'ls / | head -n 3' },
      { tier: 1, runner, steps: testSteps() },
    );
    expect(result.ok).toBe(true);
  });

  it('runs the edit tool in the container: create, edit, refuse a bad path', async () => {
    const runner = new DockerExecRunner({ container });
    const ctx = { tier: 1 as const, runner, steps: testSteps() };
    const path = "src/it's $(x).ts";

    const created = await execute({ kind: 'edit', path, oldText: '', newText: 'a = 1\n' }, ctx);
    expect(created.ok).toBe(true);
    const again = await execute({ kind: 'edit', path, oldText: '', newText: 'x' }, ctx);
    expect(!again.ok && again.error.type === 'failed' && again.error.output).toContain(
      'already exists',
    );

    const edited = await execute({ kind: 'edit', path, oldText: '1', newText: '2' }, ctx);
    expect(edited.ok).toBe(true);
    const content = await runner.run({ command: `cat 'src/it'\\''s $(x).ts'`, timeoutMs: 5000 });
    expect(content.stdout).toBe('a = 2\n');

    const missing = await execute(
      { kind: 'edit', path: 'nope.ts', oldText: 'a', newText: 'b' },
      ctx,
    );
    expect(!missing.ok && missing.error.type === 'failed' && missing.error.output).toContain(
      'does not exist',
    );

    const big = await runner.run({
      command: 'head -c 600000 /dev/zero | tr "\\0" a > big.txt',
      timeoutMs: 5000,
    });
    expect(big).toMatchObject({ status: 'exited', exitCode: 0 });
    const tooBig = await execute(
      { kind: 'edit', path: 'big.txt', oldText: 'a', newText: 'b' },
      ctx,
    );
    expect(!tooBig.ok && tooBig.error.type === 'failed' && tooBig.error.output).toContain(
      'is over 500000 bytes',
    );
  }, 20_000);
});
