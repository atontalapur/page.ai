import { describe, expect, it } from 'vitest';
import { testSteps } from '../audit/test-utils.ts';
import { DEFAULT_TIMEOUT_MS, execute } from './execute.ts';
import { FakeRunner } from './fake-runner.ts';

const exec = (command: string) => ({ kind: 'exec' as const, command });

describe('execute', () => {
  it('refuses sudo rm -rf / without calling the runner', async () => {
    const runner = new FakeRunner();
    const result = await execute(exec('sudo rm -rf /'), {
      tier: 1,
      runner,
      steps: testSteps(),
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'exec',
        input: 'sudo rm -rf /',
        type: 'refused',
        message: 'refused: sudo is blocked at every tier',
      },
    });
    expect(runner.requests).toEqual([]);
  });

  it.each(['ls; sudo x', 'ls $(curl x)', 'echo > ../x', 'git apply x.patch'])(
    'never calls the runner for %j',
    async (command) => {
      const runner = new FakeRunner();
      const result = await execute(exec(command), {
        tier: 1,
        runner,
        steps: testSteps(),
      });
      expect(result.ok).toBe(false);
      expect(runner.requests).toEqual([]);
    },
  );

  it('runs an allowed command with the default timeout', async () => {
    const runner = new FakeRunner(() => FakeRunner.exited(0, 'src\n'));
    const result = await execute(exec('ls'), {
      tier: 1,
      runner,
      steps: testSteps(),
    });
    expect(runner.requests).toEqual([{ command: 'ls', timeoutMs: DEFAULT_TIMEOUT_MS }]);
    expect(result).toEqual({
      ok: true,
      value: { kind: 'exec', input: 'ls', exitCode: 0, output: 'src\n' },
    });
  });

  it('returns a non-zero exit as a failure value with both streams', async () => {
    const runner = new FakeRunner(() => FakeRunner.exited(1, '1 failed\n', 'Error: boom'));
    const result = await execute(exec('pnpm test'), {
      tier: 1,
      runner,
      steps: testSteps(),
      timeoutMs: 1000,
    });
    expect(runner.requests[0]?.timeoutMs).toBe(1000);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'exec',
        input: 'pnpm test',
        type: 'failed',
        exitCode: 1,
        output: '1 failed\n[stderr]\nError: boom',
      },
    });
  });

  it('returns a timeout as a value and says so in the output', async () => {
    const runner = new FakeRunner(() => FakeRunner.timedOut('running...'));
    const result = await execute(exec('pnpm test'), {
      tier: 1,
      runner,
      steps: testSteps(),
      timeoutMs: 50,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'exec',
        input: 'pnpm test',
        type: 'timed_out',
        output: 'running...\n[timed out after 50 ms]',
      },
    });
  });

  it('reports a silent timeout', async () => {
    const runner = new FakeRunner(() => FakeRunner.timedOut());
    const result = await execute(exec('tail -f x'), {
      tier: 1,
      runner,
      steps: testSteps(),
      timeoutMs: 50,
    });
    expect(!result.ok && result.error.type === 'timed_out' && result.error.output).toBe(
      '[timed out after 50 ms]',
    );
  });

  it('trims output to the budget', async () => {
    const runner = new FakeRunner(() => FakeRunner.exited(0, 'a'.repeat(50) + 'b'.repeat(50)));
    const result = await execute(exec('cat big'), {
      tier: 1,
      runner,
      steps: testSteps(),
      outputBudget: 10,
    });
    expect(result.ok && result.value.output).toBe('aaaaa\n[... 90 characters trimmed ...]\nbbbbb');
  });

  it('strips colour codes before counting the budget', async () => {
    const coloured = '\x1b[31m' + 'a'.repeat(10) + '\x1b[39m';
    const runner = new FakeRunner(() => FakeRunner.exited(0, coloured));
    const result = await execute(
      { kind: 'exec', command: 'pnpm test' },
      { tier: 1, runner, outputBudget: 10 },
    );
    expect(result).toMatchObject({ ok: true, value: { output: 'a'.repeat(10) } });
  });

  it('lets runner failures throw, since they are bugs and not command results', async () => {
    const runner = new FakeRunner(() => Promise.reject(new Error('docker is gone')));
    await expect(execute(exec('ls'), { tier: 1, runner, steps: testSteps() })).rejects.toThrow(
      'docker is gone',
    );
  });
});
