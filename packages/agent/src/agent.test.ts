import { describe, expect, it } from 'vitest';
import { runAgent } from './agent.ts';
import { bash, failedResult, fakeExecute, okResult, ScriptedModel, submit } from './test-utils.ts';

const task = { task: 'GET /products returns 500: RangeError: Invalid currency code : USDD' };

describe('runAgent', () => {
  it('opens with the system prompt and the task', async () => {
    const model = new ScriptedModel([submit()]);
    await runAgent(task, { model, ...fakeExecute() });

    const [first] = model.calls as [Array<{ role: string; content: string }>];
    expect(first.map((m) => m.role)).toEqual(['system', 'user']);
    expect(first[0]!.content).toContain('page_bash');
    expect(first[1]!.content).toContain('Invalid currency code : USDD');
  });

  it('runs each action through execute and feeds the result back', async () => {
    const model = new ScriptedModel([bash('rg -n USDD src'), submit()]);
    const fake = fakeExecute((call) => okResult(call, "src/lib/money.ts:3:const C = 'USDD';"));

    const result = await runAgent(task, { model, ...fake });

    expect(fake.calls).toEqual([{ kind: 'exec', command: 'rg -n USDD src' }]);
    const second = model.calls[1]!;
    expect(second.at(-2)).toEqual({ role: 'assistant', content: bash('rg -n USDD src') });
    expect(second.at(-1)?.role).toBe('user');
    expect(second.at(-1)?.content).toContain("src/lib/money.ts:3:const C = 'USDD';");
    expect(result).toMatchObject({ exitStatus: 'submitted', modelCalls: 2 });
  });

  it('passes an edit to execute as an edit call', async () => {
    const edit = [
      '```page_edit',
      'src/lib/money.ts',
      '<<<<<<< SEARCH',
      "'USDD'",
      '=======',
      "'USD'",
      '>>>>>>> REPLACE',
      '```',
    ].join('\n');
    const fake = fakeExecute();
    await runAgent(task, { model: new ScriptedModel([edit, submit()]), ...fake });
    expect(fake.calls).toEqual([
      { kind: 'edit', path: 'src/lib/money.ts', oldText: "'USDD'", newText: "'USD'" },
    ]);
  });

  it('shows a failed command its exit code and output', async () => {
    const model = new ScriptedModel([bash('pnpm test'), submit()]);
    const fake = fakeExecute((call) => failedResult(call, 1, '1 failed'));
    await runAgent(task, { model, ...fake });
    const observation = model.calls[1]!.at(-1)!.content;
    expect(observation).toContain('<returncode>1</returncode>');
    expect(observation).toContain('1 failed');
  });

  it('ends on submit without calling execute', async () => {
    const fake = fakeExecute();
    const result = await runAgent(task, { model: new ScriptedModel([submit()]), ...fake });
    expect(fake.calls).toEqual([]);
    expect(result.exitStatus).toBe('submitted');
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: submit() });
  });

  it('answers a badly formatted reply with a format error and carries on', async () => {
    const model = new ScriptedModel(['I would look at money.ts.', bash('ls'), submit()]);
    const fake = fakeExecute();
    const result = await runAgent(task, { model, ...fake });

    const feedback = model.calls[1]!.at(-1)!;
    expect(feedback.role).toBe('user');
    expect(feedback.content).toContain('Expected exactly 1 action, found 0.');
    expect(fake.calls).toHaveLength(1);
    expect(result.exitStatus).toBe('submitted');
  });

  it('says the reply was cut off when the model hit its token limit', async () => {
    const model = new ScriptedModel([
      { content: 'THOUGHT: a very long', finishReason: 'length' },
      submit(),
    ]);
    await runAgent(task, { model, ...fakeExecute() });
    expect(model.calls[1]!.at(-1)!.content).toContain('output token limit');
  });

  it('stops after too many format errors in a row', async () => {
    const model = new ScriptedModel(['no action', 'still none', 'nope']);
    const fake = fakeExecute();
    const result = await runAgent(task, { model, ...fake }, { maxConsecutiveFormatErrors: 3 });
    expect(result.exitStatus).toBe('format_errors');
    expect(result.modelCalls).toBe(3);
    expect(fake.calls).toEqual([]);
  });

  it('resets the format error count after a good reply', async () => {
    const model = new ScriptedModel(['bad', bash('ls'), 'bad', bash('ls'), 'bad', submit()]);
    const result = await runAgent(
      task,
      { model, ...fakeExecute() },
      { maxConsecutiveFormatErrors: 2 },
    );
    expect(result.exitStatus).toBe('submitted');
  });

  it('stops at the step limit', async () => {
    const model = new ScriptedModel([bash('ls'), bash('ls'), bash('ls')]);
    const result = await runAgent(task, { model, ...fakeExecute() }, { stepLimit: 2 });
    expect(result).toMatchObject({ exitStatus: 'step_limit', modelCalls: 2 });
    expect(model.calls).toHaveLength(2);
  });

  it('stops once spending reaches the cost limit', async () => {
    const model = new ScriptedModel([bash('ls'), bash('ls'), bash('ls')], 0.3);
    const result = await runAgent(task, { model, ...fakeExecute() }, { costLimitUsd: 0.5 });
    expect(result.exitStatus).toBe('cost_limit');
    expect(result.modelCalls).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.6);
  });

  it('counts the cost of a badly formatted reply', async () => {
    const model = new ScriptedModel([{ content: 'bad', costUsd: 0.25 }, submit()], 0.25);
    const result = await runAgent(task, { model, ...fakeExecute() });
    expect(result.costUsd).toBeCloseTo(0.5);
  });

  it('stops at the wall clock limit', async () => {
    let clock = 0;
    const model = new ScriptedModel([bash('ls'), bash('ls'), bash('ls')]);
    const fake = fakeExecute((call) => {
      clock += 60_000;
      return okResult(call);
    });
    const result = await runAgent(
      task,
      { model, ...fake, now: () => clock },
      { wallTimeLimitMs: 90_000 },
    );
    expect(result).toMatchObject({ exitStatus: 'time_limit', modelCalls: 2 });
  });

  it('gives each model call and execute the time left in the budget', async () => {
    let clock = 0;
    const model = new ScriptedModel([bash('pnpm test'), submit()]);
    model.onCall = () => (clock += 100);
    const fake = fakeExecute((call) => {
      clock += 400;
      return okResult(call);
    });
    await runAgent(task, { model, ...fake, now: () => clock }, { wallTimeLimitMs: 1_000 });

    expect(model.options.map((o) => o?.timeoutMs)).toEqual([1_000, 500]);
    expect(fake.options).toEqual([{ timeoutMs: 900 }]);
  });

  it('passes no timeout when there is no wall clock limit', async () => {
    const model = new ScriptedModel([bash('ls'), submit()]);
    const fake = fakeExecute();
    await runAgent(task, { model, ...fake }, { wallTimeLimitMs: 0 });
    expect(model.options.map((o) => o?.timeoutMs)).toEqual([undefined, undefined]);
    expect(fake.options).toEqual([{}]);
  });

  it('ends on the time limit when the deadline cuts a model call short', async () => {
    let clock = 0;
    const timeout = { kind: 'network', status: null, message: 'aborted' } as const;
    const model = new ScriptedModel([timeout]);
    model.onCall = () => (clock += 1_000);
    const result = await runAgent(
      task,
      { model, ...fakeExecute(), now: () => clock },
      { wallTimeLimitMs: 1_000 },
    );
    expect(result.exitStatus).toBe('time_limit');
    expect(result.error).toBeUndefined();
  });

  it('does not start a command once the model reply used up the time', async () => {
    let clock = 0;
    const model = new ScriptedModel([bash('pnpm test')]);
    model.onCall = () => (clock += 1_000);
    const fake = fakeExecute();
    const result = await runAgent(
      task,
      { model, ...fake, now: () => clock },
      { wallTimeLimitMs: 1_000 },
    );
    expect(result).toMatchObject({ exitStatus: 'time_limit', modelCalls: 1 });
    expect(fake.calls).toEqual([]);
  });

  it('stops with the error when the model call fails', async () => {
    const error = { kind: 'rate_limited', status: 429, message: 'slow down' } as const;
    const model = new ScriptedModel([bash('ls'), error]);
    const result = await runAgent(task, { model, ...fakeExecute() });
    expect(result).toMatchObject({ exitStatus: 'model_error', modelCalls: 1, error });
  });
});
