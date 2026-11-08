import { jobFixtures } from '@page/contracts/fixtures';
import type { CompleteOptions, CompletionResult, ModelClient } from '@page/model-client';
import { FakeRunner, InMemoryAuditSink, type RunRequest } from '@page/toolkit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeLink } from '../link/fake-link.ts';
import { bashReply, ScriptedModel, submitReply } from '../model/scripted-model.ts';
import { FakeSandboxes } from '../sandbox/fake-sandboxes.ts';
import { runFixJob, type RunDeps } from './run-fix-job.ts';

const job = jobFixtures.fix;
const container = `pageagents-${job.runId}`;

function setup(
  replies: string[],
  respond?: (
    request: RunRequest,
  ) => ReturnType<FakeRunner['run']> | ReturnType<typeof FakeRunner.exited>,
  extra: Partial<RunDeps> = {},
) {
  const sandboxes = new FakeSandboxes(respond);
  const sink = new InMemoryAuditSink();
  const link = new FakeLink();
  const deps: RunDeps = {
    sandboxes,
    sink,
    link,
    model: new ScriptedModel(replies),
    logger: pino({ enabled: false }),
    ...extra,
  };
  return { deps, sandboxes, sink, link };
}

const claim = (signal = new AbortController().signal) => ({ job, signal, attempt: 0 });

describe('runFixJob', () => {
  it('runs the agent in one sandbox, records and streams each step, and cleans up', async () => {
    const { deps, sandboxes, sink, link } = setup(
      [bashReply('ls'), bashReply('curl example.com'), submitReply()],
      ({ command }) => FakeRunner.exited(0, command === 'git diff' ? 'diff --git a b\n' : 'out'),
    );
    const finished = await runFixJob(claim(), deps);

    expect(sandboxes.started).toEqual([container]);
    expect(sandboxes.running).toEqual([]);
    // The commands went into the run's container, and the refused one never did.
    expect(sandboxes.runners.get(container)?.requests.map((r) => r.command)).toEqual([
      'ls',
      'git diff',
    ]);
    expect(sink.steps).toMatchObject([
      { runId: job.runId, seq: 0, input: 'ls', allowed: true, exitCode: 0, outputTrimmed: 'out' },
      { runId: job.runId, seq: 1, input: 'curl example.com', allowed: false },
    ]);
    expect(link.sent.map((s) => s.event)).toEqual([
      'node.step',
      'node.step',
      'node.diff',
      'node.run.finished',
    ]);
    expect(link.payloads('node.step').map((p) => p.step.seq)).toEqual([0, 1]);
    expect(link.payloads('node.diff')[0]?.diff).toBe('diff --git a b\n');
    expect(finished).toMatchObject({ status: 'succeeded', confidence: null });
  });

  it('caps each command at the toolkit timeout', async () => {
    const { deps, sandboxes } = setup([bashReply('ls'), submitReply()]);
    await runFixJob(claim(), deps);
    const [ls] = sandboxes.runners.get(container)!.requests;
    expect(ls!.timeoutMs).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('takes sandbox start-up out of the agent’s time budget', async () => {
    let clock = 0;
    const { deps } = setup([bashReply('ls'), submitReply()], undefined, {
      // Every reading moves the clock on, so the shortened budget runs out at once.
      now: () => (clock += 1),
      agentConfig: { wallTimeLimitMs: 1000 },
    });
    deps.sandboxes.start = ((start) => async (runId: string) => {
      clock += 1500;
      return start(runId);
    })(deps.sandboxes.start.bind(deps.sandboxes));
    const finished = await runFixJob(claim(), deps);
    expect(finished).toMatchObject({ status: 'escalated', reason: 'budget_exhausted' });
  });

  it('escalates a run that hits its step limit and says what it tried', async () => {
    const { deps, sandboxes } = setup([bashReply('ls'), bashReply('cat a.ts')], undefined, {
      agentConfig: { stepLimit: 2 },
    });
    const finished = await runFixJob(claim(), deps);
    expect(finished).toMatchObject({
      status: 'escalated',
      toTier: 2,
      note: { tried: ['ls', 'cat a.ts'] },
    });
    expect(sandboxes.running).toEqual([]);
  });

  it('fails without starting a sandbox when the job has no report', async () => {
    const { deps, sandboxes, link } = setup([]);
    const finished = await runFixJob({ ...claim(), job: { ...job, report: undefined } }, deps);
    expect(finished).toMatchObject({ status: 'failed' });
    expect(sandboxes.started).toEqual([]);
    expect(link.payloads('node.run.finished')).toHaveLength(1);
  });

  it('fails the run when the sandbox does not start', async () => {
    const { deps, sandboxes } = setup([]);
    sandboxes.failStart = true;
    const finished = await runFixJob(claim(), deps);
    expect(finished).toMatchObject({ status: 'failed', note: { blocker: /image not found/ } });
  });

  it('fails the run and removes the sandbox when the runner breaks', async () => {
    const { deps, sandboxes } = setup([bashReply('ls')], () => {
      throw new Error('docker exec failed');
    });
    const finished = await runFixJob(claim(), deps);
    expect(finished).toMatchObject({ status: 'failed', note: { blocker: /docker exec failed/ } });
    expect(sandboxes.running).toEqual([]);
  });

  it('ends the run when the step record fails', async () => {
    const { deps, sink } = setup([bashReply('ls'), submitReply()]);
    sink.failOn = 'open';
    const finished = await runFixJob(claim(), deps);
    expect(finished).toMatchObject({ status: 'failed', note: { blocker: /audit log/ } });
  });

  it('still finishes when the diff cannot be read', async () => {
    const { deps, link } = setup([submitReply()], () => FakeRunner.exited(128, '', 'not a repo'));
    expect(await runFixJob(claim(), deps)).toMatchObject({ status: 'succeeded' });
    expect(link.payloads('node.diff')).toEqual([]);
  });

  it('still finishes when reading the diff throws', async () => {
    const { deps, link } = setup([submitReply()], () => {
      throw new Error('container gone');
    });
    expect(await runFixJob(claim(), deps)).toMatchObject({ status: 'succeeded' });
    expect(link.payloads('node.diff')).toEqual([]);
  });

  it('stops the sandbox when the queue expires the job', async () => {
    const expiry = new AbortController();
    const { deps, sandboxes } = setup([bashReply('ls'), submitReply()], ({ command }) => {
      if (command === 'ls') {
        expiry.abort();
        throw new Error('container is gone');
      }
      return FakeRunner.exited(0);
    });
    const finished = await runFixJob(claim(expiry.signal), deps);
    expect(finished).toMatchObject({ status: 'failed', note: { blocker: /expired/ } });
    expect(sandboxes.stopped).toEqual([container]);
  });

  it('reports an expiry even if the agent ended on its own', async () => {
    const expiry = new AbortController();
    const { deps } = setup([bashReply('ls'), submitReply()], () => {
      expiry.abort();
      return FakeRunner.exited(0);
    });
    expect(await runFixJob(claim(expiry.signal), deps)).toMatchObject({ status: 'failed' });
  });

  it('logs a sandbox that cannot be stopped on expiry', async () => {
    const expiry = new AbortController();
    const lines: string[] = [];
    const { deps, sandboxes } = setup(
      [bashReply('ls'), submitReply()],
      () => {
        expiry.abort();
        return FakeRunner.exited(0);
      },
      { logger: pino({}, { write: (l: string) => lines.push(l) }) },
    );
    let stops = 0;
    sandboxes.stop = () =>
      ++stops === 1 ? Promise.reject(new Error('rm failed')) : Promise.resolve();
    await runFixJob(claim(expiry.signal), deps);
    await expect.poll(() => lines.join('')).toContain('could not stop the sandbox');
    // Cleanup tried again after the failed removal.
    expect(stops).toBe(2);
  });

  it('finishes a run killed mid-command as killed and removes its sandbox', async () => {
    const kill = new AbortController();
    const { deps, sandboxes, link } = setup([bashReply('ls'), submitReply()], ({ command }) => {
      if (command === 'ls') {
        kill.abort();
        throw new Error('container is gone');
      }
      return FakeRunner.exited(0);
    });
    const finished = await runFixJob(claim(), deps, kill.signal);
    expect(finished).toMatchObject({ status: 'killed', note: { tried: ['ls'] } });
    expect(sandboxes.stopped).toEqual([container]);
    expect(sandboxes.running).toEqual([]);
    expect(link.payloads('node.diff')).toEqual([]);
  });

  it('cancels the model call a kill lands in', async () => {
    const kill = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    // Answers only when its call is cancelled, as OpenRouterClient does.
    const hanging: ModelClient = {
      complete(_messages, options?: CompleteOptions) {
        seen.push(options?.signal);
        kill.abort();
        return new Promise<CompletionResult>((resolve) => {
          const cancelled = () =>
            resolve({ ok: false, error: { kind: 'aborted', status: null, message: 'cancelled' } });
          if (options?.signal?.aborted) cancelled();
          else options?.signal?.addEventListener('abort', cancelled);
        });
      },
    };
    const { deps, sandboxes } = setup([], undefined, { model: hanging });
    const finished = await runFixJob(claim(), deps, kill.signal);
    expect(seen[0]?.aborted).toBe(true);
    expect(finished).toMatchObject({ status: 'killed' });
    expect(sandboxes.running).toEqual([]);
  });

  it('does not start a sandbox for a run killed before it began', async () => {
    const kill = new AbortController();
    kill.abort();
    const { deps, sandboxes } = setup([bashReply('ls')]);
    expect(await runFixJob(claim(), deps, kill.signal)).toMatchObject({ status: 'killed' });
    expect(sandboxes.started).toEqual([]);
  });

  it('removes the sandbox when the kill lands while it is starting', async () => {
    const kill = new AbortController();
    const { deps, sandboxes } = setup([bashReply('ls'), submitReply()]);
    deps.sandboxes.start = ((start) => (runId: string) => {
      kill.abort();
      return start(runId);
    })(sandboxes.start.bind(sandboxes));
    expect(await runFixJob(claim(), deps, kill.signal)).toMatchObject({ status: 'killed' });
    expect(sandboxes.stopped).toEqual([container]);
    expect(sandboxes.runners.get(container)?.requests).toEqual([]);
  });

  it('reports a kill over an expiry when both fire', async () => {
    const kill = new AbortController();
    const expiry = new AbortController();
    const { deps } = setup([bashReply('ls'), submitReply()], () => {
      expiry.abort();
      kill.abort();
      return FakeRunner.exited(0);
    });
    expect(await runFixJob(claim(expiry.signal), deps, kill.signal)).toMatchObject({
      status: 'killed',
    });
  });

  it('removes the sandbox once on a kill, not once more in cleanup', async () => {
    const kill = new AbortController();
    const { deps, sandboxes } = setup([bashReply('ls'), submitReply()], () => {
      kill.abort();
      return FakeRunner.exited(0);
    });
    let stops = 0;
    const stop = sandboxes.stop.bind(sandboxes);
    sandboxes.stop = (sandbox) => {
      stops += 1;
      return stop(sandbox);
    };
    await runFixJob(claim(), deps, kill.signal);
    expect(stops).toBe(1);
  });
});
