import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Capture, DockerExecRunner } from './docker-runner.ts';

// A stand-in for `docker` that runs the command locally; see the script for its modes.
const docker = fileURLToPath(new URL('./__fixtures__/fake-docker.sh', import.meta.url));

const runner = (container: string, clientGraceMs?: number) =>
  new DockerExecRunner({ container, docker, clientGraceMs });

describe('DockerExecRunner', () => {
  it('builds a docker exec with the timeout enforced in the container', async () => {
    const result = await runner('argv').run({ command: 'ls -la', timeoutMs: 1500 });
    const argv = result.stdout.trimEnd().split('\n');
    expect(argv[3]).toMatch(/^PAGE_EXEC=[0-9a-f-]{36}$/);
    expect(argv[9]).toContain('timeout -s KILL "$1" sh -c "$2"');
    expect([...argv.slice(0, 3), ...argv.slice(4, 9), ...argv.slice(10)]).toEqual([
      'exec',
      '-i',
      '-e',
      '-w',
      '/workspace',
      'argv',
      'sh',
      '-c',
      'page-exec',
      '2',
      'ls -la',
    ]);
  });

  it('rounds sub-second timeouts up to one second', async () => {
    const result = await runner('argv').run({ command: 'x', timeoutMs: 10 });
    expect(result.stdout.split('\n')[11]).toBe('1');
  });

  it('returns exit code, stdout and stderr', async () => {
    const result = await runner('sandbox').run({
      command: 'echo out; echo err >&2; exit 3',
      timeoutMs: 5000,
    });
    expect(result).toEqual({ status: 'exited', exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
  });

  it('writes stdin to the command', async () => {
    const result = await runner('sandbox').run({ command: 'cat', timeoutMs: 5000, stdin: 'hi' });
    expect(result).toMatchObject({ status: 'exited', exitCode: 0, stdout: 'hi' });
  });

  it('copes with a command that never reads stdin', async () => {
    const result = await runner('sandbox').run({
      command: 'true',
      timeoutMs: 5000,
      stdin: 'x'.repeat(1_000_000),
    });
    expect(result).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('reports a timeout when the in-container timeout kills the command', async () => {
    const result = await runner('killed').run({ command: 'sleep 9', timeoutMs: 1 });
    expect(result.status).toBe('timed_out');
  });

  it('treats a 137 before the deadline as an exit, such as an OOM kill', async () => {
    const result = await runner('killed').run({ command: 'x', timeoutMs: 60_000 });
    expect(result).toEqual({ status: 'exited', exitCode: 137, stdout: '', stderr: '' });
  });

  it('kills the docker client when the command outlives the deadline and grace', async () => {
    const result = await runner('hang', 10).run({ command: 'x', timeoutMs: 1 });
    expect(result.status).toBe('timed_out');
  });

  it('rejects when docker could not exec at all', async () => {
    await expect(runner('missing').run({ command: 'ls', timeoutMs: 1000 })).rejects.toThrow(
      'docker exec in missing failed: Error response from daemon: No such container',
    );
  });

  it('rejects when the runtime could not start the process', async () => {
    await expect(runner('oci').run({ command: 'ls', timeoutMs: 1000 })).rejects.toThrow(
      'docker exec in oci failed: OCI runtime exec failed',
    );
  });

  it('rejects when the container has no timeout', async () => {
    await expect(runner('notimeout').run({ command: 'ls', timeoutMs: 1000 })).rejects.toThrow(
      'no timeout in the container',
    );
  });

  it('rejects when the docker client dies from a signal', async () => {
    await expect(runner('signal').run({ command: 'ls', timeoutMs: 5000 })).rejects.toThrow(
      'ended without an exit code',
    );
  });

  it('rejects when the docker binary is missing', async () => {
    const missing = new DockerExecRunner({ container: 'x', docker: '/nonexistent/docker' });
    await expect(missing.run({ command: 'ls', timeoutMs: 1000 })).rejects.toThrow('ENOENT');
  });
});

describe('Capture', () => {
  it('keeps everything under the limit', () => {
    const capture = new Capture(4);
    capture.push('ab');
    capture.push('cdef');
    expect(capture.toString()).toBe('abcdef');
  });

  it('keeps the head and the tail of a long stream', () => {
    const capture = new Capture(3);
    for (const chunk of ['abc', 'def', 'ghi', 'jk']) capture.push(chunk);
    expect(capture.toString()).toBe('abc\n[... 5 characters dropped ...]\nijk');
  });
});
