import { describe, expect, it } from 'vitest';
import { testSteps } from '../audit/test-utils.ts';
import { DEFAULT_TIMEOUT_MS, execute } from './execute.ts';
import { InMemoryAuditSink } from '../audit/memory-sink.ts';
import { FakeRunner } from './fake-runner.ts';
import { trimOutput } from './trim.ts';
import { autoApprove } from './approval.ts';
import type {
  ApprovalVerdict,
  Approve,
  HostToolCall,
  HostToolOutcome,
  HostTools,
} from './types.ts';

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

  const unset = { kind: 'host_tool' as const, tool: 'ops.deleteConfig' as const, key: 'X' };

  it('refuses the ops tools below Tier 3', async () => {
    const { tools, calls } = hostTools();
    const result = await execute(unset, {
      tier: 2,
      runner: new FakeRunner(),
      steps: testSteps(),
      hostTools: tools,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        input: '{"tool":"ops.deleteConfig","key":"X"}',
        type: 'refused',
        message: 'refused: ops.deleteConfig needs Tier 3; this run is Tier 2',
      },
    });
    expect(calls).toEqual([]);
  });

  it('refuses a tool the host tools say they do not handle, and logs it', async () => {
    const sink = new InMemoryAuditSink();
    const { tools, calls } = hostTools();
    const result = await execute(unset, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(sink),
      hostTools: { ...tools, handles: (tool) => !tool.startsWith('ops.') },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'refused', message: 'refused: ops.deleteConfig is not set up on this node' },
    });
    expect(calls).toEqual([]);
    expect(sink.steps).toEqual([expect.objectContaining({ kind: 'host_tool', allowed: false })]);
  });

  it.each([
    [{ kind: 'host_tool' as const, tool: 'ops.getConfig' as const }, '{"tool":"ops.getConfig"}'],
    [
      { kind: 'host_tool' as const, tool: 'ops.setConfig' as const, key: 'K', value: '5' },
      '{"tool":"ops.setConfig","key":"K","value":"5"}',
    ],
    [{ kind: 'host_tool' as const, tool: 'ops.restart' as const }, '{"tool":"ops.restart"}'],
    [
      { kind: 'host_tool' as const, tool: 'ops.planRollback' as const },
      '{"tool":"ops.planRollback"}',
    ],
    [
      { kind: 'host_tool' as const, tool: 'ops.rollback' as const, to: 'dep-1' },
      '{"tool":"ops.rollback","to":"dep-1"}',
    ],
  ])('logs %j with its arguments', async (call, input) => {
    const sink = new InMemoryAuditSink();
    await execute(call, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(sink),
      hostTools: hostTools().tools,
      approve: autoApprove('test'),
    });
    expect(sink.steps).toEqual([expect.objectContaining({ input, allowed: true })]);
  });
});

describe('execute gated host tools', () => {
  const restart = { kind: 'host_tool' as const, tool: 'ops.restart' as const };

  function hostTools(refusal: string | null = null) {
    const calls: { call: HostToolCall; timeoutMs: number }[] = [];
    const tools: HostTools = {
      refusal: () => refusal,
      run(call, timeoutMs) {
        calls.push({ call, timeoutMs });
        return Promise.resolve(
          refusal === null ? { ok: true, output: 'restarted' } : { ok: false, output: refusal },
        );
      },
    };
    return { tools, calls };
  }

  function approver(verdict: ApprovalVerdict | Error) {
    const asked: { call: HostToolCall; timeoutMs: number }[] = [];
    const approve: Approve = (call, { timeoutMs }) => {
      asked.push({ call, timeoutMs });
      return verdict instanceof Error ? Promise.reject(verdict) : Promise.resolve(verdict);
    };
    return { approve, asked };
  }

  it('refuses a gated tool when the run has no way to ask, and runs nothing', async () => {
    const sink = new InMemoryAuditSink();
    const { tools, calls } = hostTools();
    const result = await execute(restart, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(sink),
      hostTools: tools,
    });
    const message =
      "refused: ops.restart needs a person's approval, and this run has no way to ask for it";
    expect(result).toMatchObject({ ok: false, error: { type: 'refused', message } });
    expect(calls).toEqual([]);
    expect(sink.steps).toEqual([
      expect.objectContaining({ allowed: false, outputTrimmed: message, exitCode: null }),
    ]);
  });

  it('runs an approved call with the time its approval left', async () => {
    const sink = new InMemoryAuditSink();
    const { tools, calls } = hostTools();
    const { approve, asked } = approver({ approved: true, by: 'ui:arjun' });
    const result = await execute(restart, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(sink),
      hostTools: tools,
      approve,
      timeoutMs: 60_000,
    });
    expect(asked).toEqual([{ call: restart, timeoutMs: 60_000 }]);
    expect(result).toMatchObject({ ok: true, value: { output: 'restarted' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.timeoutMs).toBeGreaterThan(59_000);
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(60_000);
    expect(sink.steps).toEqual([expect.objectContaining({ allowed: true, exitCode: 0 })]);
  });

  it('refuses a rejected call, which the agent reads as a refusal, and runs nothing', async () => {
    const sink = new InMemoryAuditSink();
    const { tools, calls } = hostTools();
    const { approve } = approver({ approved: false, reason: 'arjun rejected it' });
    const result = await execute(restart, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(sink),
      hostTools: tools,
      approve,
    });
    const message = 'refused: ops.restart was not approved: arjun rejected it';
    expect(result).toEqual({
      ok: false,
      error: { kind: 'host_tool', input: '{"tool":"ops.restart"}', type: 'refused', message },
    });
    expect(calls).toEqual([]);
    expect(sink.steps).toEqual([
      expect.objectContaining({ allowed: false, outputTrimmed: message, exitCode: null }),
    ]);
  });

  it('asks with the thought behind the call, and keeps it on the step a person rejected', async () => {
    const sink = new InMemoryAuditSink();
    const { tools } = hostTools();
    const thoughts: (string | undefined)[] = [];
    const approve: Approve = (_call, { thought }) => {
      thoughts.push(thought);
      return Promise.resolve({ approved: false, reason: 'arjun rejected it' });
    };
    const thought = 'The override is wrong, so a restart loads the env value.';
    await execute(restart, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(sink),
      hostTools: tools,
      approve,
      thought,
    });
    expect(thoughts).toEqual([thought]);
    expect(sink.steps).toEqual([expect.objectContaining({ allowed: false, thought })]);
  });

  it('refuses the call when asking breaks', async () => {
    const { tools, calls } = hostTools();
    const { approve } = approver(new Error('socket gone'));
    const result = await execute(restart, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(),
      hostTools: tools,
      approve,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        type: 'refused',
        message: 'refused: ops.restart was not approved: asking for approval failed',
      },
    });
    expect(calls).toEqual([]);
  });

  it('asks no one for a call the tool would refuse, and lets the tool refuse it', async () => {
    const { tools, calls } = hostTools('this run has restarted the app 3 times');
    const { approve, asked } = approver({ approved: true, by: 'ui:arjun' });
    const result = await execute(restart, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(),
      hostTools: tools,
      approve,
    });
    expect(asked).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { type: 'failed', exitCode: 1 } });
  });

  it.each([
    { kind: 'host_tool' as const, tool: 'ops.getConfig' as const },
    { kind: 'host_tool' as const, tool: 'ops.planRollback' as const },
  ])('asks no one for $tool, a read', async (call) => {
    const { tools, calls } = hostTools();
    const { approve, asked } = approver({ approved: false, reason: 'no' });
    await execute(call, {
      tier: 3,
      runner: new FakeRunner(),
      steps: testSteps(),
      hostTools: tools,
      approve,
    });
    expect(asked).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
