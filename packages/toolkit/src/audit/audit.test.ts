import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { execute, LOG_INPUT_BUDGET } from '../exec/execute.ts';
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

  it('keeps the refusal and its reason when the refusal cannot be written', async () => {
    const { sink, runner, ctx } = setup();
    sink.failOn = 'open';
    const result = await execute(exec('sudo rm -rf /'), ctx);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'exec',
        input: 'sudo rm -rf /',
        type: 'refused',
        message: 'refused: sudo is blocked at every tier',
        auditFailed: true,
      },
    });
    expect(runner.requests).toEqual([]);
  });

  it('returns what the command did when its outcome cannot be written', async () => {
    const { sink, runner, ctx } = setup(() => FakeRunner.exited(1, 'FAIL a.test.ts\n'));
    sink.failOn = 'close';
    const result = await execute(exec('pnpm test'), ctx);
    expect(runner.requests).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'exec',
        input: 'pnpm test',
        type: 'audit_failed',
        ran: true,
        message: 'audit log write failed after the command ran; its outcome is not on record',
        result: {
          ok: false,
          error: {
            kind: 'exec',
            input: 'pnpm test',
            type: 'failed',
            exitCode: 1,
            output: 'FAIL a.test.ts\n',
          },
        },
      },
    });
    expect(sink.steps[0]).toMatchObject({ allowed: true, exitCode: null, outputTrimmed: '' });
  });

  it('returns a successful result too when its outcome cannot be written', async () => {
    const { sink, ctx } = setup(() => FakeRunner.exited(0, 'src\n'));
    sink.failOn = 'close';
    const result = await execute(exec('ls'), ctx);
    expect(result).toMatchObject({
      ok: false,
      error: {
        type: 'audit_failed',
        ran: true,
        result: { ok: true, value: { exitCode: 0, output: 'src\n' } },
      },
    });
  });

  it('closes the step when the runner breaks, then rethrows', async () => {
    const { sink, ctx } = setup(() => Promise.reject(new Error('docker is gone')));
    await expect(execute(exec('ls'), ctx)).rejects.toThrow('docker is gone');
    expect(sink.steps[0]).toMatchObject({
      exitCode: null,
      outputTrimmed: 'runner error: Error: docker is gone',
    });
  });

  it('trims a runner error to the output budget', async () => {
    const huge = 'x'.repeat(5_000);
    const { sink, ctx } = setup(() => Promise.reject(new Error(huge)));
    await expect(execute(exec('ls'), { ...ctx, outputBudget: 100 })).rejects.toThrow(huge);
    const { outputTrimmed } = sink.steps[0]!;
    expect(outputTrimmed).toMatch(
      /^runner error: Error: x+\n\[\.\.\. \d+ characters trimmed \.\.\.\]\nx+$/,
    );
    expect(outputTrimmed.length).toBeLessThan(200);
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

  it('carries on numbering for a run that already has steps', async () => {
    const { sink, ctx } = setup();
    const stored = { runId: TEST_RUN_ID, kind: 'exec' as const, input: 'ls' };
    sink.steps.push(
      { ...stored, seq: 0, outputTrimmed: '', exitCode: 0, allowed: true },
      { ...stored, seq: 1, outputTrimmed: '', exitCode: 0, allowed: true },
    );
    // A fresh StepLog, as after a daemon restart.
    await execute(exec('ls'), { ...ctx, steps: testSteps(sink) });
    expect(sink.steps.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(sink.steps[2]).toMatchObject({ exitCode: 0, allowed: true });
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

  it('logs an edit by path and lengths, and a long command trimmed', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const steps = new StepLog({
      sink: new InMemoryAuditSink(),
      issueId: TEST_ISSUE_ID,
      runId: TEST_RUN_ID,
      logger,
    });
    const runner = new FakeRunner();
    const secret = 'API_KEY=sk-live-should-not-be-logged';
    await execute(
      { kind: 'edit', path: '.env', oldText: '', newText: secret },
      { tier: 1, runner, steps },
    );
    await execute(
      { kind: 'edit', path: '.github/x', oldText: '', newText: secret },
      { tier: 1, runner, steps },
    );
    await execute(exec(`echo ${'y'.repeat(5_000)}`), { tier: 1, runner, steps });

    expect(lines.join('')).not.toContain(secret);
    const running = lines.map((line) => JSON.parse(line) as { msg: string; input: unknown });
    expect(running[0]).toMatchObject({
      msg: 'running',
      input: { path: '.env', oldTextLength: 0, newTextLength: secret.length },
    });
    const command = running.find((line) => typeof line.input === 'string')!.input as string;
    expect(command).toContain('characters trimmed');
    expect(command.length).toBeLessThan(LOG_INPUT_BUDGET + 100);
    // The steps row still holds the whole edit.
    expect(JSON.parse((steps.sink as InMemoryAuditSink).steps[0]!.input)).toMatchObject({
      newText: secret,
    });
  });
});

describe('InMemoryAuditSink', () => {
  it('numbers steps per run and rejects closing a step that was never opened', async () => {
    const sink = new InMemoryAuditSink();
    const step = {
      runId: TEST_RUN_ID,
      kind: 'exec' as const,
      input: 'ls',
      outputTrimmed: '',
      exitCode: null,
      allowed: true,
    };
    const otherRun = { ...step, runId: '00000000-0000-4000-8000-000000000003' };
    expect([await sink.open(step), await sink.open(step), await sink.open(otherRun)]).toEqual([
      0, 1, 0,
    ]);
    await expect(sink.close(TEST_RUN_ID, 5, { outputTrimmed: '', exitCode: 0 })).rejects.toThrow(
      'never opened',
    );
  });
});
