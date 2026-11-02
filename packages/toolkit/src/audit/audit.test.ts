import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { execute } from '../exec/execute.ts';
import { FakeRunner } from '../exec/fake-runner.ts';
import { InMemoryAuditSink } from './memory-sink.ts';
import { StepLog } from './step-log.ts';
import { TEST_ISSUE_ID, TEST_RUN_ID, testSteps } from './test-utils.ts';

const exec = (command: string) => ({ kind: 'exec' as const, command });

function setup(respond?: ConstructorParameters<typeof FakeRunner>[0]) {
  const sink = new InMemoryAuditSink();
  const runner = new FakeRunner(respond);
  return { sink, runner, ctx: { tier: 1 as const, runner, steps: testSteps(sink) } };
}

describe('execute audit log', () => {
  it('writes sudo rm -rf / as one refused step and never runs it', async () => {
    const { sink, runner, ctx } = setup();
    const result = await execute(exec('sudo rm -rf /'), ctx);
    expect(result.ok).toBe(false);
    expect(runner.requests).toEqual([]);
    expect(sink.steps).toEqual([
      {
        runId: TEST_RUN_ID,
        seq: 0,
        kind: 'exec',
        input: 'sudo rm -rf /',
        outputTrimmed: 'refused: sudo is blocked at every tier',
        exitCode: null,
        allowed: false,
      },
    ]);
  });

  it('writes one step per call with increasing seq and each outcome', async () => {
    const { sink, ctx } = setup(({ command }) =>
      command === 'ls' ? FakeRunner.exited(0, 'src\n') : FakeRunner.exited(1, '', 'boom'),
    );
    await execute(exec('ls'), ctx);
    await execute(exec('pnpm test'), ctx);
    await execute(exec('curl x'), ctx);
    expect(
      sink.steps.map(({ seq, input, exitCode, allowed, outputTrimmed }) => ({
        seq,
        input,
        exitCode,
        allowed,
        outputTrimmed,
      })),
    ).toEqual([
      { seq: 0, input: 'ls', exitCode: 0, allowed: true, outputTrimmed: 'src\n' },
      { seq: 1, input: 'pnpm test', exitCode: 1, allowed: true, outputTrimmed: '[stderr]\nboom' },
      {
        seq: 2,
        input: 'curl x',
        exitCode: null,
        allowed: false,
        outputTrimmed: expect.stringMatching(/^refused: /) as string,
      },
    ]);
  });

  it('records a timeout with no exit code', async () => {
    const { sink, ctx } = setup(() => FakeRunner.timedOut('partial'));
    await execute(exec('pnpm test'), { ...ctx, timeoutMs: 10 });
    expect(sink.steps[0]).toMatchObject({
      allowed: true,
      exitCode: null,
      outputTrimmed: 'partial\n[timed out after 10 ms]',
    });
  });

  it('audits an edit, and a refused edit, as edit steps', async () => {
    const { sink, ctx } = setup(() => FakeRunner.exited(0));
    await execute({ kind: 'edit', path: 'new.ts', oldText: '', newText: 'x' }, ctx);
    await execute({ kind: 'edit', path: '.github/ci.yml', oldText: '', newText: 'x' }, ctx);
    expect(sink.steps).toMatchObject([
      { seq: 0, kind: 'edit', allowed: true, exitCode: 0, outputTrimmed: 'created new.ts' },
      { seq: 1, kind: 'edit', allowed: false, exitCode: null },
    ]);
    expect(JSON.parse(sink.steps[0]!.input)).toEqual({ path: 'new.ts', oldText: '', newText: 'x' });
  });

  it('does not run the command when the step cannot be written', async () => {
    const { sink, runner, ctx } = setup();
    sink.failOn = 'open';
    const result = await execute(exec('ls'), ctx);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'exec',
        input: 'ls',
        type: 'audit_failed',
        ran: false,
        message: 'audit log write failed, so the command was not run',
      },
    });
    expect(runner.requests).toEqual([]);
  });

  it('returns an err for a refusal it could not write', async () => {
    const { sink, ctx } = setup();
    sink.failOn = 'open';
    const result = await execute(exec('sudo rm -rf /'), ctx);
    expect(result).toMatchObject({ ok: false, error: { type: 'audit_failed', ran: false } });
  });

  it('reports a failed outcome write as an err, saying the command ran', async () => {
    const { sink, runner, ctx } = setup();
    sink.failOn = 'close';
    const result = await execute(exec('ls'), ctx);
    expect(runner.requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: { type: 'audit_failed', ran: true } });
    expect(sink.steps[0]).toMatchObject({ allowed: true, exitCode: null, outputTrimmed: '' });
  });

  it('closes the step when the runner breaks, then rethrows', async () => {
    const { sink, ctx } = setup(() => Promise.reject(new Error('docker is gone')));
    await expect(execute(exec('ls'), ctx)).rejects.toThrow('docker is gone');
    expect(sink.steps[0]).toMatchObject({
      exitCode: null,
      outputTrimmed: 'runner error: Error: docker is gone',
    });
  });

  it('still rethrows the runner error when closing the step fails too', async () => {
    const sink = new InMemoryAuditSink();
    const runner = new FakeRunner(() => {
      sink.failOn = 'close';
      return Promise.reject(new Error('docker is gone'));
    });
    await expect(execute(exec('ls'), { tier: 1, runner, steps: testSteps(sink) })).rejects.toThrow(
      'docker is gone',
    );
  });

  it('logs issueId, runId and tier on every line', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'info' },
      { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const sink = new InMemoryAuditSink();
    const steps = new StepLog({ sink, issueId: TEST_ISSUE_ID, runId: TEST_RUN_ID, logger });
    const runner = new FakeRunner(() => FakeRunner.exited(1));
    await execute(exec('ls'), { tier: 2, runner, steps });
    await execute(exec('sudo x'), { tier: 2, runner, steps });
    sink.failOn = 'open';
    await execute(exec('ls'), { tier: 2, runner, steps });
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line).toMatchObject({ issueId: TEST_ISSUE_ID, runId: TEST_RUN_ID, tier: 2 });
    }
  });
});

describe('StepLog', () => {
  it('numbers from firstSeq', () => {
    const steps = new StepLog({
      sink: new InMemoryAuditSink(),
      issueId: TEST_ISSUE_ID,
      runId: TEST_RUN_ID,
      firstSeq: 7,
    });
    expect([steps.next(), steps.next()]).toEqual([7, 8]);
  });
});

describe('InMemoryAuditSink', () => {
  it('rejects a duplicate seq and closing a step that was never opened', async () => {
    const sink = new InMemoryAuditSink();
    const entry = {
      runId: TEST_RUN_ID,
      seq: 0,
      kind: 'exec' as const,
      input: 'ls',
      outputTrimmed: '',
      exitCode: null,
      allowed: true,
    };
    await sink.open(entry);
    await expect(sink.open(entry)).rejects.toThrow('already exists');
    await expect(sink.close(TEST_RUN_ID, 1, { outputTrimmed: '', exitCode: 0 })).rejects.toThrow(
      'never opened',
    );
  });
});
