import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UserExecRunner } from './user-runner.ts';

// A stand-in for `su-exec`; see the script for its modes.
const suExec = fileURLToPath(new URL('./__fixtures__/fake-su-exec.sh', import.meta.url));
const workspace = tmpdir();

const runner = (user: string) =>
  new UserExecRunner({
    user,
    env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
    maxProcesses: 64,
    suExec,
    workspace,
  });

describe('UserExecRunner', () => {
  it('switches user, clears the env and caps processes before the wrapper', async () => {
    const result = await runner('argv').run({ command: 'ls -la', timeoutMs: 1500 });
    const argv = result.stdout.trimEnd().split('\n');
    expect(argv[5]).toMatch(/^PAGE_EXEC=[0-9a-f-]{36}$/);
    expect(argv[14]).toContain('timeout -s KILL "$1" sh -c "$2"');
    expect([...argv.slice(0, 5), ...argv.slice(6, 14), ...argv.slice(15)]).toEqual([
      'argv',
      'env',
      '-i',
      'PATH=/usr/bin:/bin',
      'HOME=/tmp',
      'NO_COLOR=1',
      'FORCE_COLOR=0',
      'sh',
      '-c',
      'ulimit -u "$0" && exec "$@"',
      '64',
      'sh',
      '-c',
      'page-exec',
      '2',
      'ls -la',
      // The working directory the runner started it in.
      expect.stringMatching(new RegExp(`${workspace.replace(/\/$/, '')}$`)),
    ]);
  });

  it("gives a command only the runner's variables, none of the daemon's", async () => {
    process.env.PAGE_TEST_SECRET = 'hunter2';
    try {
      const result = await runner('sandbox').run({
        command: 'echo "secret=${PAGE_TEST_SECRET:-none} home=$HOME color=$NO_COLOR"',
        timeoutMs: 5000,
      });
      expect(result).toMatchObject({
        status: 'exited',
        exitCode: 0,
        stdout: 'secret=none home=/tmp color=1\n',
      });
    } finally {
      delete process.env.PAGE_TEST_SECRET;
    }
  });

  it('returns exit code, stdout and stderr', async () => {
    const result = await runner('sandbox').run({
      command: 'echo out; echo err >&2; exit 3',
      timeoutMs: 5000,
    });
    expect(result).toEqual({ status: 'exited', exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
  });

  it('rejects when su-exec is missing', async () => {
    const missing = new UserExecRunner({
      user: 'sandbox',
      env: {},
      maxProcesses: 64,
      suExec: '/nonexistent/su-exec',
      workspace,
    });
    await expect(missing.run({ command: 'true', timeoutMs: 1000 })).rejects.toThrow(/ENOENT/);
  });
});
