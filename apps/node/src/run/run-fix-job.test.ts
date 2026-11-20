import { MAX_RUN_DIFF_CHARS } from '@page/contracts';
import { jobFixtures } from '@page/contracts/fixtures';
import type { CompleteOptions, CompletionResult, ModelClient } from '@page/model-client';
import {
  FakeGitHub,
  FakeOps,
  FakeRunner,
  InMemoryAuditSink,
  SAFE_GIT,
  type RunRequest,
} from '@page/toolkit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeLink } from '../link/fake-link.ts';
import { bashReply, ScriptedModel, submitReply } from '../model/scripted-model.ts';
import { FakeSandboxes } from '../sandbox/fake-sandboxes.ts';
import { FakeRunResults, type RunResults } from './results.ts';
import { runFixJob, type RunDeps } from './run-fix-job.ts';

const job = jobFixtures.fix;
const DIFF = `${SAFE_GIT} diff --no-ext-diff --no-textconv`;
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
  const results = new FakeRunResults();
  const deps: RunDeps = {
    sandboxes,
    sink,
    link,
    results,
    model: new ScriptedModel(replies),
    logger: pino({ enabled: false }),
    ...extra,
  };
  return { deps, sandboxes, sink, link, results };
}

const claim = (signal = new AbortController().signal) => ({ job, signal, attempt: 0 });

describe('runFixJob', () => {
  it('runs the agent in one sandbox, records and streams each step, and cleans up', async () => {
    const { deps, sandboxes, sink, link } = setup(
      [bashReply('ls'), bashReply('curl example.com'), submitReply()],
      ({ command }) => FakeRunner.exited(0, command === DIFF ? 'diff --git a b\n' : 'out'),
    );
    const finished = await runFixJob(claim(), deps);

    expect(sandboxes.started).toEqual([container]);
    expect(sandboxes.running).toEqual([]);
    // The commands went into the run's container, and the refused one never did.
    expect(sandboxes.runners.get(container)?.requests.map((r) => r.command)).toEqual(['ls', DIFF]);
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

  it('queues the result for the orchestrator with the run times and the diff', async () => {
    let clock = Date.parse('2026-11-18T10:00:00.000Z');
    const { deps, results, link } = setup(
      [bashReply('ls'), submitReply()],
      ({ command }) => FakeRunner.exited(0, command === DIFF ? 'diff --git a b\n' : 'out'),
      { now: () => (clock += 1000) },
    );
    const finished = await runFixJob(claim(), deps);
    const [sent] = results.sent;
    expect(sent).toMatchObject({
      v: 1,
      issueId: job.issueId,
      tier: job.tier,
      startedAt: '2026-11-18T10:00:01.000Z',
      diff: 'diff --git a b\n',
      result: finished,
    });
    expect(Date.parse(sent!.finishedAt)).toBeGreaterThan(Date.parse(sent!.startedAt));
    expect(results.sent).toHaveLength(1);
    expect(link.payloads('node.run.finished')).toEqual([finished]);
  });

  it('records no diff for a run that did not submit, or one over the cap', async () => {
    const failed = setup([bashReply('ls')], undefined, { agentConfig: { stepLimit: 1 } });
    await runFixJob(claim(), failed.deps);
    expect(failed.results.sent).toMatchObject([{ diff: null, result: { status: 'escalated' } }]);

    const huge = 'x'.repeat(MAX_RUN_DIFF_CHARS + 1);
    const big = setup([submitReply()], ({ command }) =>
      FakeRunner.exited(0, command === DIFF ? huge : ''),
    );
    await runFixJob(claim(), big.deps);
    expect(big.results.sent).toMatchObject([{ diff: null, result: { status: 'succeeded' } }]);
    expect(big.link.payloads('node.diff')[0]?.diff).toBe(huge);
  });

  it('rejects when the result cannot be queued, after removing the sandbox', async () => {
    const results: RunResults = { send: () => Promise.reject(new Error('database is down')) };
    const { deps, sandboxes } = setup([submitReply()], undefined, { results });
    await expect(runFixJob(claim(), deps)).rejects.toThrow('database is down');
    expect(sandboxes.running).toEqual([]);
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

  it('reports a kill that lands while a failing sandbox start runs as killed', async () => {
    const kill = new AbortController();
    const { deps, sandboxes } = setup([]);
    sandboxes.failStart = true;
    deps.sandboxes.start = ((start) => (runId: string) => {
      kill.abort();
      return start(runId);
    })(sandboxes.start.bind(sandboxes));
    expect(await runFixJob(claim(), deps, kill.signal)).toMatchObject({ status: 'killed' });
  });

  it('reports a kill that lands after the agent submitted as killed', async () => {
    const kill = new AbortController();
    const { deps, link } = setup([submitReply()], ({ command }) => {
      // The kill arrives while the diff is being read, and takes the container with it.
      if (command === DIFF) {
        kill.abort();
        throw new Error('container is gone');
      }
      return FakeRunner.exited(0);
    });
    expect(await runFixJob(claim(), deps, kill.signal)).toMatchObject({ status: 'killed' });
    expect(link.payloads('node.diff')).toEqual([]);
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

  describe('Tier 2 host tools', () => {
    const pushReply = '```page_push_branch\nfix: currency code\n```';
    const prReply = '```page_open_pr\nfix: currency code\nUSDD was a typo.\n```';
    const path = 'apps/demo-app/lib/money.ts';
    // The sandbox as the host tools read it: one changed file.
    const workspace = ({ command }: RunRequest) => {
      if (command.startsWith(`${SAFE_GIT} status`)) return FakeRunner.exited(0, ` M ${path}\0`);
      if (command.startsWith('stat -c')) return FakeRunner.exited(0, '4 644 regular file\n');
      if (command.startsWith('base64')) return FakeRunner.exited(0, 'VVNECg==\n.\n');
      return FakeRunner.exited(0, '');
    };
    const tier2 = (extra: Partial<typeof job> = {}) => ({
      ...claim(),
      job: { ...job, tier: 2 as const, ...extra },
    });

    it('pushes the fix, opens a PR and reports its url when the run finishes', async () => {
      const github = new FakeGitHub({ [path]: "'USDD'\n" });
      const { deps, sink } = setup([pushReply, prReply, submitReply()], workspace, { github });
      const finished = await runFixJob(tier2(), deps);

      const branch = `pageagents/${job.runId}`;
      expect(github.files(branch)[path]!.text).toBe('USD\n');
      expect(github.pullRequests).toMatchObject([
        { title: 'fix: currency code', head: branch, base: 'main' },
      ]);
      expect(github.pullRequests[0]!.body).toContain(`run \`${job.runId}\``);
      expect(sink.steps).toMatchObject([
        { kind: 'host_tool', allowed: true, exitCode: 0 },
        { kind: 'host_tool', allowed: true, exitCode: 0 },
      ]);
      expect(finished).toMatchObject({
        status: 'succeeded',
        prUrl: 'https://github.com/page-demo/shop/pull/1',
      });
      expect(github.pullRequests[0]).toMatchObject({ state: 'open' });
    });

    it('puts the escalation note from the tier below in the PR body', async () => {
      const github = new FakeGitHub({ [path]: "'USDD'\n" });
      const { deps } = setup([pushReply, prReply, submitReply()], workspace, { github });
      const escalationNote = {
        summary: 'Tier 1 ran out of steps.',
        tried: ['cat lib/money.ts'],
        blocker: 'Out of steps.',
      };
      await runFixJob(tier2({ escalationNote }), deps);
      expect(github.pullRequests[0]!.body).toContain(
        '### Escalation note from the tier below\n\nTier 1 ran out of steps.',
      );
    });

    it('closes the PR of a run that escalates after opening it', async () => {
      const github = new FakeGitHub({ [path]: "'USDD'\n" });
      const { deps } = setup([pushReply, prReply, bashReply('ls')], workspace, {
        github,
        agentConfig: { stepLimit: 3 },
      });
      const finished = await runFixJob(tier2(), deps);

      expect(finished).toMatchObject({ status: 'escalated', toTier: 3, prUrl: null });
      expect(github.pullRequests[0]).toMatchObject({ state: 'closed' });
      expect(github.pullRequests[0]!.comments[0]).toMatch(
        new RegExp(`run \`${job.runId}\` ended as escalated`),
      );
    });

    it('still reports the PR when it cannot be closed', async () => {
      const github = new FakeGitHub({ [path]: "'USDD'\n" });
      github.failOn.add('closePullRequest');
      const { deps } = setup([pushReply, prReply, bashReply('ls')], workspace, {
        github,
        agentConfig: { stepLimit: 3 },
      });
      const finished = await runFixJob(tier2(), deps);
      expect(finished).toMatchObject({
        status: 'escalated',
        prUrl: 'https://github.com/page-demo/shop/pull/1',
      });
    });

    it('sends nothing to GitHub once the run is killed', async () => {
      const github = new FakeGitHub({ [path]: "'USDD'\n" });
      const kill = new AbortController();
      const { deps } = setup(
        [bashReply('ls'), pushReply, submitReply()],
        (request) => {
          if (request.command === 'ls') kill.abort();
          return workspace(request);
        },
        { github },
      );
      const finished = await runFixJob(tier2(), deps, kill.signal);
      expect(finished).toMatchObject({ status: 'killed', prUrl: null });
      expect(github.calls).toEqual([]);
    });

    it('refuses the host tools at Tier 1 and logs the refusal', async () => {
      const github = new FakeGitHub({ [path]: "'USDD'\n" });
      const { deps, sink } = setup([pushReply, submitReply()], workspace, { github });
      const finished = await runFixJob(claim(), deps);

      expect(job.tier).toBe(1);
      expect(github.head(`pageagents/${job.runId}`)).toBeUndefined();
      expect(sink.steps).toMatchObject([
        {
          kind: 'host_tool',
          allowed: false,
          outputTrimmed: 'refused: git.pushBranch needs Tier 2; this run is Tier 1',
        },
      ]);
      expect(finished).toMatchObject({ status: 'succeeded', prUrl: null });
    });

    it('refuses the host tools when the node has no GitHub', async () => {
      const { deps, sink } = setup([pushReply, submitReply()], workspace);
      await runFixJob(tier2(), deps);
      expect(sink.steps).toMatchObject([
        { allowed: false, outputTrimmed: 'refused: git.pushBranch is not set up on this node' },
      ]);
    });
  });

  describe('Tier 3 ops tools', () => {
    const configReply = '```page_ops_config\n```';
    const setReply = '```page_ops_set\nSHIPPING_FLAT_CENTS=500\n```';
    const unsetReply = '```page_ops_unset\nSHIPPING_FLAT_CENTS\n```';
    const restartReply = '```page_ops_restart\n```';
    const atTier = (tier: 1 | 2 | 3) => ({ ...claim(), job: { ...job, tier } });

    it('reads, sets and drops a setting on the live app and restarts it', async () => {
      const ops = new FakeOps({ SHIPPING_FLAT_CENTS: '2500000000' });
      const { deps, sink } = setup(
        [configReply, setReply, unsetReply, restartReply, submitReply()],
        undefined,
        { ops },
      );
      const finished = await runFixJob(atTier(3), deps);

      expect(ops.calls).toEqual([
        'getConfig',
        'setConfig SHIPPING_FLAT_CENTS=500',
        'deleteConfig SHIPPING_FLAT_CENTS',
        'restart',
      ]);
      expect(ops.served).toEqual({});
      expect(sink.steps).toMatchObject(
        Array.from({ length: 4 }, () => ({ kind: 'host_tool', allowed: true, exitCode: 0 })),
      );
      expect(finished).toMatchObject({ status: 'succeeded' });
    });

    it('keeps the GitHub tools next to the ops tools', async () => {
      const ops = new FakeOps();
      const github = new FakeGitHub({ 'a.ts': 'x\n' });
      const pushReply = '```page_push_branch\nfix: shipping\n```';
      const workspace = ({ command }: RunRequest) => {
        if (command.startsWith(`${SAFE_GIT} status`)) return FakeRunner.exited(0, ` M a.ts\0`);
        if (command.startsWith('stat -c')) return FakeRunner.exited(0, '2 644 regular file\n');
        if (command.startsWith('base64')) return FakeRunner.exited(0, 'eQo=\n.\n');
        return FakeRunner.exited(0, '');
      };
      const { deps, sink } = setup([configReply, pushReply, submitReply()], workspace, {
        ops,
        github,
      });
      await runFixJob(atTier(3), deps);

      expect(ops.calls).toEqual(['getConfig']);
      expect(github.head(`pageagents/${job.runId}`)).toBeDefined();
      expect(sink.steps).toMatchObject([{ allowed: true }, { allowed: true }]);
    });

    it.each([1, 2] as const)('never reaches the ops API at Tier %i', async (tier) => {
      const ops = new FakeOps();
      const { deps, sink } = setup([configReply, restartReply, submitReply()], undefined, {
        ops,
      });
      await runFixJob(atTier(tier), deps);

      expect(ops.calls).toEqual([]);
      expect(sink.steps).toMatchObject([
        {
          allowed: false,
          outputTrimmed: `refused: ops.getConfig needs Tier 3; this run is Tier ${tier}`,
        },
        {
          allowed: false,
          outputTrimmed: `refused: ops.restart needs Tier 3; this run is Tier ${tier}`,
        },
      ]);
    });

    it('refuses the ops tools when the node has no ops API', async () => {
      const { deps, sink } = setup([configReply, submitReply()]);
      await runFixJob(atTier(3), deps);
      expect(sink.steps).toMatchObject([
        { allowed: false, outputTrimmed: 'refused: ops.getConfig is not set up on this node' },
      ]);
    });

    it.each(['kill', 'expiry'] as const)(
      'aborts an ops call in flight when the %s fires',
      async (stop) => {
        const kill = new AbortController();
        const expiry = new AbortController();
        let seen: AbortSignal | undefined;
        // The run is stopped while the app is restarting.
        class StoppedMidRestart extends FakeOps {
          override restart(signal?: AbortSignal) {
            seen = signal;
            (stop === 'kill' ? kill : expiry).abort();
            return super.restart();
          }
        }
        const { deps } = setup([restartReply, submitReply()], undefined, {
          ops: new StoppedMidRestart(),
        });
        await runFixJob({ ...atTier(3), signal: expiry.signal }, deps, kill.signal);
        expect(seen?.aborted).toBe(true);
      },
    );
  });
});
