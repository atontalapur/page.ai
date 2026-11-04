import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@page/model-client';
import { runAgent } from './agent.ts';
import { instancePrompt, systemPrompt } from './prompts.ts';
import { recordingDeps, ReplayDivergence, replayDeps, type Turn } from './transcript.ts';
import { bash, failedResult, fakeExecute, okResult, ScriptedModel, submit } from './test-utils.ts';

const task = { task: 'checkout returns 500' };
const opening: ChatMessage[] = [
  { role: 'system', content: systemPrompt() },
  { role: 'user', content: instancePrompt(task) },
];

const modelTurn = (content: string, sent: ChatMessage[] = opening): Turn => ({
  type: 'model',
  sent,
  reply: { ok: true, completion: { content, finishReason: 'stop', model: 'm', costUsd: 0 } },
});

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

  it('logs the messages each model call added since the last one', async () => {
    const { turns } = await recordRun();
    const sent = turns.flatMap((t) => (t.type === 'model' ? [t.sent] : []));
    expect(sent[0]).toEqual(opening);
    expect(sent[1]!.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(sent[1]![0]!.content).toBe(bash('rg -n total src'));
    expect(sent[1]![1]!.content).toContain('src/cart.ts:9:total');
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
    expect(recording.turns).toEqual([
      { type: 'model', sent: opening, reply: { ok: false, error } },
    ]);
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

  // The recorded fixtures ran on a free model, so this is the only replay of the cost limit.
  it('replays a run that ended on the cost limit', async () => {
    const model = new ScriptedModel([bash('ls'), bash('ls'), bash('ls')], 0.01);
    const config = { costLimitUsd: 0.025 };
    const recording = recordingDeps({ model, ...fakeExecute() });
    const run = await runAgent(task, recording.deps, config);

    const replayed = await runAgent(task, replayDeps(recording).deps, config);
    expect(replayed).toEqual(run);
    expect(replayed.exitStatus).toBe('cost_limit');
    expect(replayed.costUsd).toBeCloseTo(0.03);
  });

  it('fails when the loop runs a different command than was recorded', async () => {
    const turns: Turn[] = [
      modelTurn(bash('ls')),
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

  it('fails when the prompt the loop sends has changed', async () => {
    const { turns, clock } = await recordRun();
    const changed = { task: 'checkout returns 502' };
    await expect(runAgent(changed, replayDeps({ turns, clock }).deps)).rejects.toThrow(
      /turn 0: message 1 \(user\) differs from the recording/,
    );
  });

  it('fails when an observation the loop builds has changed', async () => {
    const { turns, clock } = await recordRun();
    const edited = structuredClone(turns);
    const exec = edited[1]!;
    if (exec.type !== 'execute' || !exec.result.ok) throw new Error('expected an ok execute');
    exec.result.value.output = 'something else';
    await expect(runAgent(task, replayDeps({ turns: edited, clock }).deps)).rejects.toThrow(
      /turn 2: message 1 \(user\) differs from the recording/,
    );
  });

  it('fails when the loop sends more messages than were recorded', async () => {
    const turns: Turn[] = [modelTurn(submit(), opening.slice(0, 1))];
    await expect(runAgent(task, replayDeps({ turns, clock: [] }).deps)).rejects.toThrow(
      /turn 0: the loop sent 2 new messages, the recording has 1/,
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
      modelTurn(reply),
      { type: 'execute', call: edit, result: okResult(edit) },
    ];
    await expect(runAgent(task, replayDeps({ turns, clock: [] }).deps)).rejects.toThrow(
      /turn 1: the loop ran a different call/,
    );
  });
});
