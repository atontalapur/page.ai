import { describe, expect, it } from 'vitest';
import { runAgent } from './agent.ts';
import { recordingDeps, ReplayDivergence, replayDeps, type Turn } from './transcript.ts';
import { bash, failedResult, fakeExecute, okResult, ScriptedModel, submit } from './test-utils.ts';

const task = { task: 'checkout returns 500' };

async function recordRun() {
  const model = new ScriptedModel([bash('rg -n total src'), bash('pnpm test'), submit()], 0.01);
  const fake = fakeExecute((call) =>
    call.kind === 'exec' && call.command === 'pnpm test'
      ? failedResult(call, 1, '1 failed')
      : okResult(call, 'src/cart.ts:9:total'),
  );
  let clock = 1_000;
  const recording = recordingDeps({ model, execute: fake.execute, now: () => (clock += 10) });
  const run = await runAgent(task, recording.deps);
  return { run, turns: recording.turns, clock: recording.clock };
}

describe('recordingDeps', () => {
  it('logs every model reply and execute call in order', async () => {
    const { turns } = await recordRun();
    expect(turns.map((t) => t.type)).toEqual(['model', 'execute', 'model', 'execute', 'model']);
    expect(turns[1]).toMatchObject({
      type: 'execute',
      call: { kind: 'exec', command: 'rg -n total src' },
      result: { ok: true, value: { output: 'src/cart.ts:9:total' } },
    });
    expect(turns[3]).toMatchObject({ result: { ok: false, error: { type: 'failed' } } });
  });

  it('logs the clock readings the loop took', async () => {
    const { clock } = await recordRun();
    expect(clock.length).toBeGreaterThan(0);
    expect(clock[0]).toBe(1_010);
  });

  it('logs a failed model call', async () => {
    const error = { kind: 'auth', status: 401, message: 'bad key' } as const;
    const recording = recordingDeps({ model: new ScriptedModel([error]), ...fakeExecute() });
    await runAgent(task, recording.deps);
    expect(recording.turns).toEqual([{ type: 'model', reply: { ok: false, error } }]);
  });
});

describe('replayDeps', () => {
  it('drives the loop to the same end without a model or a sandbox', async () => {
    const { run, turns, clock } = await recordRun();
    const replay = replayDeps({ turns, clock });

    const replayed = await runAgent(task, replay.deps);

    expect(replayed).toEqual(run);
    expect(replay.remaining()).toBe(0);
  });

  it('replays a run that ended on the wall clock limit', async () => {
    let now = 0;
    const model = new ScriptedModel([bash('ls'), bash('ls'), bash('ls')]);
    const fake = fakeExecute((call) => {
      now += 60_000;
      return okResult(call);
    });
    const config = { wallTimeLimitMs: 90_000 };
    const recording = recordingDeps({ model, execute: fake.execute, now: () => now });
    const run = await runAgent(task, recording.deps, config);

    const replayed = await runAgent(task, replayDeps(recording).deps, config);
    expect(replayed).toEqual(run);
    expect(replayed.exitStatus).toBe('time_limit');
  });

  it('fails when the loop runs a different command than was recorded', async () => {
    const turns: Turn[] = [
      {
        type: 'model',
        reply: {
          ok: true,
          completion: { content: bash('ls'), finishReason: 'stop', model: 'm', costUsd: 0 },
        },
      },
      {
        type: 'execute',
        call: { kind: 'exec', command: 'ls -la' },
        result: okResult({ kind: 'exec', command: 'ls -la' }),
      },
    ];
    await expect(runAgent(task, replayDeps({ turns, clock: [] }).deps)).rejects.toThrow(
      ReplayDivergence,
    );
  });

  it('fails when the loop calls the model where an execute was recorded', async () => {
    const call = { kind: 'exec', command: 'ls' } as const;
    const turns: Turn[] = [{ type: 'execute', call, result: okResult(call) }];
    await expect(runAgent(task, replayDeps({ turns, clock: [] }).deps)).rejects.toThrow(
      /turn 0: the loop called the model, but the transcript has an execute/,
    );
  });

  it('fails when the transcript runs out', async () => {
    await expect(runAgent(task, replayDeps({ turns: [], clock: [] }).deps)).rejects.toThrow(
      /turn 0: the loop called the model, but the transcript has ended/,
    );
  });

  it('compares edit calls field by field', async () => {
    const edit = { kind: 'edit', path: 'a.ts', oldText: 'x', newText: 'y' } as const;
    const reply = [
      '```page_edit',
      'a.ts',
      '<<<<<<< SEARCH',
      'x',
      '=======',
      'z',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n');
    const turns: Turn[] = [
      {
        type: 'model',
        reply: {
          ok: true,
          completion: { content: reply, finishReason: 'stop', model: 'm', costUsd: 0 },
        },
      },
      { type: 'execute', call: edit, result: okResult(edit) },
    ];
    await expect(runAgent(task, replayDeps({ turns, clock: [] }).deps)).rejects.toThrow(
      /turn 1: the loop ran a different call/,
    );
  });
});
