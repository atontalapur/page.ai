import { jobFixtures, nodeEnvFixture } from '@page/contracts/fixtures';
import {
  FakeDeployer,
  FakeGitHub,
  FakeOps,
  FakeRunner,
  HttpOps,
  InMemoryAuditSink,
  RailwayDeployer,
  rollback,
} from '@page/toolkit';
import type pg from 'pg';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.ts';
import {
  approvalsFor,
  createDaemon,
  deployerFor,
  opsFor,
  opsLockFor,
  sandboxesFor,
  type Adapters,
} from './daemon.ts';
import { FakeJobSource } from './jobs/fake-job-source.ts';
import { FakeLink } from './link/fake-link.ts';
import { ScriptedModel, submitReply } from './model/scripted-model.ts';
import { autoApprovals, LinkApprovals } from './run/approvals.ts';
import { FakeRunResults } from './run/results.ts';
import { DockerSandboxes } from './sandbox/docker-sandboxes.ts';
import { FakeSandboxes, fakeWorkspace } from './sandbox/fake-sandboxes.ts';
import { LocalSandboxes } from './sandbox/local-sandboxes.ts';
import type { Sandboxes } from './sandbox/sandbox.ts';

function adapters() {
  const close = vi.fn(() => Promise.resolve());
  const a = {
    jobs: new FakeJobSource(),
    // The fake adapters' workspace and model: a run that tests a one-file fix and submits.
    sandboxes: new FakeSandboxes(fakeWorkspace),
    sink: new InMemoryAuditSink(),
    link: new FakeLink(),
    results: new FakeRunResults(),
    model: new ScriptedModel(),
    github: new FakeGitHub(),
    close,
  } satisfies Adapters;
  return { ...a, closed: close };
}

describe('createDaemon', () => {
  it('runs each claimed job and streams its steps', async () => {
    const a = adapters();
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    await a.jobs.deliver(jobFixtures.fix);

    expect(a.sink.steps).toMatchObject([
      { runId: jobFixtures.fix.runId, input: 'pnpm --filter @page/demo-app test' },
    ]);
    expect(a.link.sent.map((s) => s.event)).toEqual([
      'node.step',
      'node.diff',
      'node.run.finished',
    ]);
    expect(a.results.sent).toMatchObject([
      { issueId: jobFixtures.fix.issueId, tier: 1, result: { status: 'succeeded' } },
    ]);
  });

  it('stops claiming before it closes the adapters, even if stopping fails', async () => {
    const a = adapters();
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    await daemon.stop();
    expect(a.jobs.stopped).toBe(true);
    expect(a.closed).toHaveBeenCalledOnce();

    a.jobs.stop = () => Promise.reject(new Error('offWork failed'));
    await expect(daemon.stop()).rejects.toThrow('offWork failed');
    expect(a.closed).toHaveBeenCalledTimes(2);
  });

  it('kills the run a run.kill names and leaves no sandbox behind', async () => {
    const a = adapters();
    const { runId } = jobFixtures.fix;
    const sandboxes = new FakeSandboxes(() => {
      a.link.deliver('run.kill', { v: 1, runId });
      return FakeRunner.exited(0);
    });
    const daemon = createDaemon({ ...a, sandboxes }, pino({ enabled: false }));
    await daemon.start();
    await a.jobs.deliver(jobFixtures.fix);

    expect(a.link.payloads('node.run.finished')).toMatchObject([{ runId, status: 'killed' }]);
    expect(sandboxes.started).toEqual([`pageagents-${runId}`]);
    expect(sandboxes.running).toEqual([]);
  });

  it('ignores a kill for a run it is not holding', async () => {
    const a = adapters();
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    a.link.deliver('run.kill', { v: 1, runId: jobFixtures.fix.runId });
    await a.jobs.deliver(jobFixtures.fix);
    expect(a.link.payloads('node.run.finished')).toMatchObject([{ status: 'succeeded' }]);
  });

  it('reaps leftover sandboxes before it claims a job', async () => {
    const a = adapters();
    a.sandboxes.strays = ['pageagents-old'];
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    expect(a.sandboxes.stopped).toEqual(['pageagents-old']);
  });

  it('still claims jobs when a leftover sandbox cannot be removed', async () => {
    const a = adapters();
    const sandboxes: Sandboxes = {
      start: (runId) => a.sandboxes.start(runId),
      stop: (sandbox) => a.sandboxes.stop(sandbox),
      reap: () =>
        Promise.resolve({
          removed: ['pageagents-a'],
          failed: [{ name: 'pageagents-stuck', error: new Error('removal in progress') }],
        }),
    };
    const daemon = createDaemon({ ...a, sandboxes }, pino({ enabled: false }));
    await daemon.start();
    await a.jobs.deliver(jobFixtures.fix);
    expect(a.link.payloads('node.run.finished')).toMatchObject([{ status: 'succeeded' }]);
  });

  it('adds the kill handler once however many times it starts', async () => {
    const a = adapters();
    const on = vi.spyOn(a.link, 'on');
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    await daemon.start();
    expect(on).toHaveBeenCalledOnce();
  });

  it('keeps a newer attempt killable when an older one of the same run finishes', async () => {
    const a = adapters();
    const { runId } = jobFixtures.fix;
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let commands = 0;
    // Attempt one's first command and attempt two's diff wait until they are let go.
    const sandboxes = new FakeSandboxes(async (request) => {
      const gate = gates[commands++];
      if (gate !== undefined) await gate.promise;
      return fakeWorkspace(request);
    });
    const daemon = createDaemon({ ...a, sandboxes }, pino({ enabled: false }));
    await daemon.start();
    const first = a.jobs.deliver(jobFixtures.fix);
    await vi.waitFor(() => expect(commands).toBe(1));
    const second = a.jobs.deliver(jobFixtures.fix);
    await vi.waitFor(() => expect(commands).toBe(2));

    gates[0]?.resolve();
    await first;
    a.link.deliver('run.kill', { v: 1, runId });
    gates[1]?.resolve();
    await second;
    expect(a.link.payloads('node.run.finished')).toMatchObject([
      { status: 'succeeded' },
      { status: 'killed' },
    ]);
  });

  it('gives a Tier 3 job the ops API', async () => {
    const ops = new FakeOps();
    const a = {
      ...adapters(),
      ops,
      model: new ScriptedModel(['```page_ops_config\n```', submitReply()]),
    };
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    await a.jobs.deliver({ ...jobFixtures.fix, tier: 3 });
    expect(ops.calls).toEqual(['getConfig']);
  });

  const deploys = () =>
    new FakeDeployer([
      {
        id: 'bad',
        status: 'SUCCESS',
        createdAt: '2026-11-20T00:00:00Z',
        commitSha: null,
        canRollback: true,
      },
      {
        id: 'good',
        status: 'REMOVED',
        createdAt: '2026-11-19T00:00:00Z',
        commitSha: null,
        canRollback: true,
      },
    ]);
  const rollbackModel = () =>
    new ScriptedModel([
      '```page_ops_rollback_plan\n```',
      '```page_ops_rollback\ngood\n```',
      submitReply(),
    ]);

  it('gives a Tier 3 job the deployer for a rollback, and its approvals', async () => {
    const deployer = deploys();
    const a = {
      ...adapters(),
      ops: new FakeOps(),
      deployer,
      approvals: autoApprovals('test'),
      model: rollbackModel(),
    };
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    await a.jobs.deliver({ ...jobFixtures.fix, tier: 3 });
    expect(deployer.rollbacks).toEqual(['good']);
  });

  it('refuses a Tier 3 rollback on a daemon that has no way to ask a person', async () => {
    const deployer = deploys();
    const a = { ...adapters(), ops: new FakeOps(), deployer, model: rollbackModel() };
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    await a.jobs.deliver({ ...jobFixtures.fix, tier: 3 });
    expect(deployer.rollbacks).toEqual([]);
    expect(a.sink.steps.at(-1)).toMatchObject({ allowed: false });
  });

  describe('asking the orchestrator', () => {
    const tier3 = { ...jobFixtures.fix, tier: 3 as const };
    const restartModel = () => new ScriptedModel(['```page_ops_restart\n```', submitReply()]);

    function asking() {
      const ops = new FakeOps();
      const base = adapters();
      const a = {
        ...base,
        ops,
        model: restartModel(),
        approvals: new LinkApprovals({ link: base.link, logger: pino({ enabled: false }) }),
      };
      const asked = () => a.link.payloads('node.approval.request');
      return { a, ops, asked };
    }

    it('restarts the app once a person approves, on the same link', async () => {
      const { a, ops, asked } = asking();
      const daemon = createDaemon(a, pino({ enabled: false }));
      await daemon.start();
      const done = a.jobs.deliver(tier3);
      await vi.waitFor(() => expect(asked()).toHaveLength(1));
      const request = asked()[0]!;
      a.link.deliver('approval.decided', {
        v: 1,
        approval: {
          id: request.approvalId,
          runId: request.runId,
          issueId: tier3.issueId,
          action: request.action,
          args: request.args,
          requestedAt: request.expiresAt,
          expiresAt: request.expiresAt,
          decision: 'approved',
          decidedBy: 'ui:arjun',
          decidedAt: request.expiresAt,
        },
      });
      await done;
      expect(ops.calls).toEqual(['restart']);
      expect(a.sink.steps).toMatchObject([
        { input: '{"tool":"ops.restart"}', allowed: true, exitCode: 0 },
      ]);
    });

    it("sends the agent's THOUGHT with the request, as plain text", async () => {
      const { a, asked } = asking();
      a.model = new ScriptedModel([
        'THOUGHT: The <b>override</b> is wrong; a restart loads the env value.\n\n```page_ops_restart\n```',
        submitReply(),
      ]);
      const daemon = createDaemon(a, pino({ enabled: false }));
      await daemon.start();
      const done = a.jobs.deliver(tier3);
      await vi.waitFor(() => expect(asked()).toHaveLength(1));
      expect(asked()[0]?.reason).toBe(
        'The <b>override</b> is wrong; a restart loads the env value.',
      );
      a.link.deliver('run.kill', { v: 1, runId: tier3.runId });
      await done;
    });

    it('stops waiting and runs nothing when the run is killed while it waits', async () => {
      const { a, ops, asked } = asking();
      const daemon = createDaemon(a, pino({ enabled: false }));
      await daemon.start();
      const done = a.jobs.deliver(tier3);
      await vi.waitFor(() => expect(asked()).toHaveLength(1));
      a.link.deliver('run.kill', { v: 1, runId: tier3.runId });
      await done;
      expect(ops.calls).toEqual([]);
      expect(a.sink.steps).toMatchObject([
        {
          allowed: false,
          outputTrimmed:
            'refused: ops.restart was not approved: the run was stopped while it waited',
        },
      ]);
      expect(a.link.payloads('node.run.finished')).toMatchObject([{ status: 'killed' }]);
    });
  });
});

describe('approvalsFor', () => {
  const lines: { level: number; msg: string }[] = [];
  const logger = pino(
    {},
    { write: (line: string) => void lines.push(JSON.parse(line) as (typeof lines)[number]) },
  );
  const config = (env: Record<string, string>) => {
    const result = loadConfig({ ...nodeEnvFixture, ...env });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it('asks a person through the orchestrator unless AUTO_APPROVE_OPS is on', async () => {
    const asking = approvalsFor(config({}), new FakeLink(), logger);
    expect(asking).toBeInstanceOf(LinkApprovals);
    expect(asking.asksPerson).toBe(true);
    expect(lines).toEqual([]);

    const auto = approvalsFor(config({ AUTO_APPROVE_OPS: 'true' }), new FakeLink(), logger);
    expect(auto.asksPerson).toBe(false);
    const approve = auto.forRun({
      runId: 'r',
      signal: new AbortController().signal,
      args: () => ({}),
    });
    await expect(
      approve({ kind: 'host_tool', tool: 'ops.restart' }, { timeoutMs: 1 }),
    ).resolves.toEqual({ approved: true, by: 'AUTO_APPROVE_OPS' });
    expect(lines).toMatchObject([
      { level: 40, msg: 'AUTO_APPROVE_OPS is on: gated ops calls run without asking anyone' },
    ]);
  });
});

describe('sandboxesFor', () => {
  const config = (env: Record<string, string>) => {
    const result = loadConfig({ ...nodeEnvFixture, ...env });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it('uses a container per run by default, the local workspace on request, and fakes over both', () => {
    expect(sandboxesFor(config({}))).toBeInstanceOf(DockerSandboxes);
    expect(sandboxesFor(config({ SANDBOX_RUNTIME: 'local' }))).toBeInstanceOf(LocalSandboxes);
    const fake = config({ SANDBOX_RUNTIME: 'local', USE_FAKE_ADAPTERS: 'true' });
    expect(sandboxesFor(fake)).toBeInstanceOf(FakeSandboxes);
  });
});

describe('opsFor', () => {
  const capture = () => {
    const lines: { level: number; msg: string }[] = [];
    const logger = pino(
      {},
      { write: (line: string) => void lines.push(JSON.parse(line) as (typeof lines)[number]) },
    );
    return { logger, lines };
  };
  const config = (env: Record<string, string>) => {
    const result = loadConfig({ ...nodeEnvFixture, ...env });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it('talks to the live demo app when its URL and ops secret are set', () => {
    const { logger, lines } = capture();
    const env = { OPS_APP_URL: 'https://demo.example.com', OPS_SECRET: 'a'.repeat(32) };
    expect(opsFor(config(env), logger)).toBeInstanceOf(HttpOps);
    expect(lines).toEqual([]);
  });

  it('gives no ops API without them, and says so once', () => {
    const { logger, lines } = capture();
    // Staging's app in DEMO_APP_URL must not reach the daemon.
    const env = { DEMO_APP_URL: 'https://staging.example.com', OPS_SECRET: 'a'.repeat(32) };
    expect(opsFor(config(env), logger)).toBeUndefined();
    expect(lines).toMatchObject([
      { level: 40, msg: 'OPS_APP_URL is unset: Tier 3 runs get no ops tools' },
    ]);
  });

  it('uses an in-memory ops API with fakes on', () => {
    const { logger } = capture();
    expect(opsFor(config({ USE_FAKE_ADAPTERS: 'true' }), logger)).toBeInstanceOf(FakeOps);
  });
});

describe('deployerFor', () => {
  const capture = () => {
    const lines: { level: number; msg: string }[] = [];
    const logger = pino(
      {},
      { write: (line: string) => void lines.push(JSON.parse(line) as (typeof lines)[number]) },
    );
    return { logger, lines };
  };
  const config = (env: Record<string, string>) => {
    const result = loadConfig({ ...nodeEnvFixture, ...env });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const app = { OPS_APP_URL: 'https://demo.example.com', OPS_SECRET: 'a'.repeat(32) };
  const railway = {
    OPS_RAILWAY_TOKEN: 'project-token',
    OPS_RAILWAY_PROJECT_ID: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
    OPS_RAILWAY_ENVIRONMENT_ID: '0b4a3a5e-9a3c-4c8e-8f0e-1f2d3c4b5a69',
    OPS_RAILWAY_SERVICE_ID: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
  };

  it("rolls back the ops app's Railway service when it is set", () => {
    const { logger, lines } = capture();
    expect(deployerFor(config({ ...app, ...railway }), logger)).toBeInstanceOf(RailwayDeployer);
    expect(lines).toEqual([]);
  });

  it('gives no deployer without it, and says so once on a node with ops tools', () => {
    const withOps = capture();
    expect(deployerFor(config(app), withOps.logger)).toBeUndefined();
    expect(withOps.lines).toMatchObject([
      { level: 40, msg: 'OPS_RAILWAY_* is unset: Tier 3 runs get no rollback tool' },
    ]);
    // Without OPS_APP_URL, opsFor has said Tier 3 runs get no ops tools at all.
    const without = capture();
    expect(deployerFor(config({}), without.logger)).toBeUndefined();
    expect(without.lines).toEqual([]);
  });

  it('uses an in-memory deployer with fakes on, with something to roll back to', async () => {
    const { logger } = capture();
    const fake = deployerFor(config({ ...railway, USE_FAKE_ADAPTERS: 'true' }), logger);
    expect(fake).toBeInstanceOf(FakeDeployer);
    expect(await rollback(fake!, { dryRun: true })).toMatchObject({
      ok: true,
      value: { plan: { from: { id: 'fake-live' }, to: { id: 'fake-before' } } },
    });
  });
});

describe('opsLockFor', () => {
  const pool = {} as pg.Pool;
  const logger = pino({ enabled: false });
  const config = (env: Record<string, string>) => {
    const result = loadConfig({ ...nodeEnvFixture, ...env });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it('claims the app at OPS_APP_URL, and nothing without it or with fakes on', () => {
    const env = { OPS_APP_URL: 'https://demo.example.com', OPS_SECRET: 'a'.repeat(32) };
    expect(opsLockFor(config(env), pool, logger)).toBeDefined();
    expect(opsLockFor(config({}), pool, logger)).toBeUndefined();
    expect(opsLockFor(config({ ...env, USE_FAKE_ADAPTERS: 'true' }), pool, logger)).toBeUndefined();
  });
});
