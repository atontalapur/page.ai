import { describe, expect, it } from 'vitest';
import { testSteps } from '../audit/test-utils.ts';
import { DEFAULT_TIMEOUT_MS, execute } from './execute.ts';
import { InMemoryAuditSink } from '../audit/memory-sink.ts';
import { FakeRunner } from './fake-runner.ts';
import { trimOutput } from './trim.ts';
import type { HostToolCall, HostToolOutcome, HostTools } from './types.ts';

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
      { tier: 1, runner, steps: testSteps(), outputBudget: 10 },
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

describe('execute host tools', () => {
  const push = { kind: 'host_tool' as const, tool: 'git.pushBranch' as const, message: 'fix' };
  const openPr = {
    kind: 'host_tool' as const,
    tool: 'github.openPr' as const,
    title: 'fix it',
    body: 'why',
  };

  function hostTools(outcome: HostToolOutcome = { ok: true, output: 'pushed' }) {
    const calls: { call: HostToolCall; timeoutMs: number }[] = [];
    const tools: HostTools = {
      run(call, timeoutMs) {
        calls.push({ call, timeoutMs });
        return Promise.resolve(outcome);
      },
    };
    return { tools, calls };
  }

  it('refuses a host tool at Tier 1 and logs the refusal as a host_tool step', async () => {
    const sink = new InMemoryAuditSink();
    const { tools, calls } = hostTools();
    const result = await execute(push, {
      tier: 1,
      runner: new FakeRunner(),
      steps: testSteps(sink),
      hostTools: tools,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'host_tool',
        input: '{"tool":"git.pushBranch","message":"fix"}',
        type: 'refused',
        message: 'refused: git.pushBranch needs Tier 2; this run is Tier 1',
      },
    });
    expect(calls).toEqual([]);
    expect(sink.steps).toEqual([
      expect.objectContaining({
        kind: 'host_tool',
        input: '{"tool":"git.pushBranch","message":"fix"}',
        allowed: false,
        exitCode: null,
        outputTrimmed: 'refused: git.pushBranch needs Tier 2; this run is Tier 1',
      }),
    ]);
  });

  it('refuses a host tool at Tier 2 when the node has none set up', async () => {
    const result = await execute(openPr, { tier: 2, runner: new FakeRunner(), steps: testSteps() });
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'refused', message: 'refused: github.openPr is not set up on this node' },
    });
  });

  it('runs a host tool at Tier 2 with the timeout, and logs its outcome', async () => {
    const sink = new InMemoryAuditSink();
    const { tools, calls } = hostTools({ ok: true, output: 'opened PR #1' });
    const result = await execute(openPr, {
      tier: 2,
      runner: new FakeRunner(),
      steps: testSteps(sink),
      hostTools: tools,
      timeoutMs: 1234,
    });
    expect(calls).toEqual([{ call: openPr, timeoutMs: 1234 }]);
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'host_tool',
        input: '{"tool":"github.openPr","title":"fix it","body":"why"}',
        exitCode: 0,
        output: 'opened PR #1',
      },
    });
    expect(sink.steps).toEqual([
      expect.objectContaining({
        kind: 'host_tool',
        allowed: true,
        exitCode: 0,
        outputTrimmed: 'opened PR #1',
      }),
    ]);
  });

  it('returns a failed host tool as exit 1, trimmed to the budget', async () => {
    const { tools, calls } = hostTools({ ok: false, output: 'x'.repeat(500) });
    const result = await execute(push, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(),
      hostTools: tools,
      outputBudget: 100,
    });
    expect(calls[0]!.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'failed', exitCode: 1, output: trimOutput('x'.repeat(500), 100) },
    });
  });
});
