import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  NODE_NAMESPACE,
  serverToNodeEvents,
  serverToUiEvents,
  UI_NAMESPACE,
  type NodeSummary,
  type ServerToUiEvents,
  type Step,
} from '@page/contracts';
import {
  escalationNoteFixture,
  nodeToServerEventFixtures,
  stepFixture,
  uiToServerEventFixtures,
} from '@page/contracts/fixtures';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { FIX_QUEUE, type FixJob } from '../queue/fix-jobs.ts';
import { RunsService } from '../runs/runs.service.ts';
import { NODE_HANDSHAKES_PER_MINUTE, NODE_MESSAGES_PER_10_SECONDS } from './node.gateway.ts';
import { Nodes } from './nodes.ts';
import { outcome, TestSockets } from './test-utils.ts';

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(deps, false);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = await app.getUrl();
afterAll(async () => {
  await app.close();
  await deps.close();
});

const secret = testConfig.nodeSharedSecret ?? '';
const nodes = new TestSockets(`${base}${NODE_NAMESPACE}`, '192.0.2');
const tabs = new TestSockets(`${base}${UI_NAMESPACE}`, '203.0.113');
afterEach(() => {
  nodes.closeAll();
  tabs.closeAll();
});

const issues = app.get(IssuesService);
let n = 0;

/** An issue in `fixing` at tier 1, and the run its fix job carries. */
async function fixing(): Promise<{ issueId: string; runId: string }> {
  const { issue } = await issues.report(
    { fingerprint: `node-gateway-${++n}`, title: 'Boom' },
    'GET /\n\nTypeError: boom',
  );
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const row = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', issue.id)
    .executeTakeFirstOrThrow();
  return { issueId: issue.id, runId: row.current_run_id ?? '' };
}

async function connected(socket: Socket): Promise<Socket> {
  expect(await outcome(socket)).toBe('connected');
  return socket;
}

const daemon = () => connected(nodes.connect({ token: secret }));
const namedDaemon = (name: string) => connected(nodes.connect({ token: secret, name }));
const ui = () => connected(tabs.connect({ token: testConfig.apiToken }));

/** The run ids of each `run.kill` a daemon gets, checked against its contract. */
function kills(node: Socket): string[] {
  const runIds: string[] = [];
  node.on('run.kill', (payload: unknown) => {
    runIds.push(serverToNodeEvents['run.kill'].parse(payload).runId);
  });
  return runIds;
}

type UiEvent = keyof ServerToUiEvents;

/**
 * Every run and node event a tab gets, in order, each parsed against its contract as the UI
 * parses it. Node events come as `node.updated <name>`, for one daemon's only.
 */
async function timeline(name: string) {
  const socket = await ui();
  const seen: { event: string; node?: NodeSummary }[] = [];
  socket.onAny((event: UiEvent, payload: unknown) => {
    if (event === 'issue.updated') return;
    if (event !== 'node.updated') {
      serverToUiEvents[event].parse(payload);
      seen.push({ event });
      return;
    }
    const { node } = serverToUiEvents['node.updated'].parse(payload);
    if (node.name === name) seen.push({ event: `node.updated ${name}`, node });
  });
  return seen;
}

/** Every run event a tab gets, each parsed against its contract as the UI parses it. */
async function tab() {
  const socket = await ui();
  const seen: { event: UiEvent; ok: boolean; payload: unknown }[] = [];
  socket.onAny((event: UiEvent, payload: unknown) => {
    if (event === 'issue.updated' || event === 'node.updated') return;
    const parsed = serverToUiEvents[event].safeParse(payload);
    seen.push({ event, ok: parsed.success, payload: parsed.data });
  });
  return seen;
}

const step = (runId: string, seq: number, input = `cmd ${seq}`): Step => ({
  ...stepFixture,
  runId,
  seq,
  input,
});

describe('node socket', () => {
  it('refuses a daemon without the shared secret or with a wrong one', async () => {
    expect(await outcome(nodes.connect({}))).toBe('unauthorized');
    expect(await outcome(nodes.connect({ token: 'wrong' }))).toBe('unauthorized');
    expect(await outcome(nodes.connect({ token: `Bearer ${secret}` }))).toBe('unauthorized');
    // The UI's token opens the UI's namespace only.
    expect(await outcome(nodes.connect({ token: testConfig.apiToken }))).toBe('unauthorized');
    expect(await outcome(nodes.connect({ token: secret }))).toBe('connected');
  });

  it('does not open the UI namespace with the shared secret', async () => {
    expect(await outcome(tabs.connect({ token: secret }))).toBe('unauthorized');
  });

  it(`refuses an address's handshakes past ${NODE_HANDSHAKES_PER_MINUTE} a minute`, async () => {
    const address = '198.51.100.9';
    for (let i = 0; i < NODE_HANDSHAKES_PER_MINUTE; i++) {
      expect(await outcome(nodes.connect({ token: 'wrong' }, address))).toBe('unauthorized');
    }
    expect(await outcome(nodes.connect({ token: secret }, address))).toBe('rate_limited');
    expect(await outcome(nodes.connect({ token: secret }))).toBe('connected');
  });

  it(`closes a socket that sends more than ${NODE_MESSAGES_PER_10_SECONDS} messages in 10s`, async () => {
    const socket = await daemon();
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    for (let i = 0; i <= NODE_MESSAGES_PER_10_SECONDS; i++) socket.emit('node.diff', { v: 1 });
    expect(await closed).toBe('io server disconnect');
  });
});

describe('node events to the UI', () => {
  it('relays a run as run.started, run.step, run.diff and run.finished', async () => {
    const { issueId, runId } = await fixing();
    const seen = await tab();
    const node = await daemon();

    node.emit('node.step', { v: 1, step: step(runId, 0, 'ls') });
    node.emit('node.step', { v: 1, step: step(runId, 1, 'pnpm test') });
    node.emit('node.diff', { v: 1, runId, diff: '--- a/x\n+++ b/x\n' });
    node.emit('node.run.finished', {
      v: 1,
      runId,
      status: 'escalated',
      prUrl: null,
      confidence: null,
      reason: 'tests_failing',
      toTier: 2,
      note: escalationNoteFixture,
    });

    await expect.poll(() => seen.length).toBe(5);
    expect(seen.every((s) => s.ok)).toBe(true);
    expect(seen.map((s) => s.event)).toEqual([
      'run.started',
      'run.step',
      'run.step',
      'run.diff',
      'run.finished',
    ]);
    const [started, first, second, diff, finished] = seen.map((s) => s.payload);
    expect(started).toEqual({
      v: 1,
      run: {
        id: runId,
        issueId,
        tier: 1,
        status: 'running',
        startedAt: stepFixture.createdAt,
        finishedAt: null,
        prUrl: null,
        confidence: null,
      },
    });
    expect(first).toEqual({ v: 1, step: step(runId, 0, 'ls') });
    expect(second).toMatchObject({ step: { seq: 1, input: 'pnpm test' } });
    expect(diff).toEqual({ v: 1, runId, diff: '--- a/x\n+++ b/x\n' });
    expect(finished).toMatchObject({
      run: { id: runId, issueId, tier: 1, status: 'escalated', prUrl: null },
      note: escalationNoteFixture,
    });
  });

  it('records nothing: the run stays in fixing with no row until its run_finished job', async () => {
    const { issueId, runId } = await fixing();
    const seen = await tab();
    const node = await daemon();
    node.emit('node.run.finished', { ...nodeToServerEventFixtures['node.run.finished'], runId });
    await expect.poll(() => seen.length).toBe(1);
    expect(await issues.get(issueId)).toMatchObject({ status: 'fixing' });
    const rows = await deps.db.selectFrom('runs').selectAll().where('id', '=', runId).execute();
    expect(rows).toEqual([]);
    const steps = await deps.db
      .selectFrom('steps')
      .selectAll()
      .where('run_id', '=', runId)
      .execute();
    expect(steps).toEqual([]);
  });

  it('sends run.started only for a first step, and only for a run in progress', async () => {
    const { runId } = await fixing();
    const seen = await tab();
    const node = await daemon();
    // A daemon back after a restart carries on from a later step.
    node.emit('node.step', { v: 1, step: step(runId, 4) });
    // A run no issue knows still has its step relayed.
    node.emit('node.step', { v: 1, step: step(randomUUID(), 0) });
    await expect.poll(() => seen.length).toBe(2);
    expect(seen.map((s) => s.event)).toEqual(['run.step', 'run.step']);
  });

  it('drops an event that breaks its contract and keeps the socket', async () => {
    const { runId } = await fixing();
    const seen = await tab();
    const node = await daemon();
    node.emit('node.step', { v: 1, step: { ...step(runId, 0), seq: -1 } });
    node.emit('node.diff', { v: 2, runId, diff: '' });
    node.emit('node.diff', { v: 1, runId, diff: 'kept' });
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ event: 'run.diff', payload: { diff: 'kept' } });
    expect(node.connected).toBe(true);
  });

  it('leaves node.approval.request for Tier 3 approvals', async () => {
    const { runId } = await fixing();
    const seen = await tab();
    const node = await daemon();
    node.emit('node.approval.request', {
      ...nodeToServerEventFixtures['node.approval.request'],
      runId,
    });
    node.emit('node.diff', { v: 1, runId, diff: '' });
    await expect.poll(() => seen.length).toBe(1);
    expect(seen.map((s) => s.event)).toEqual(['run.diff']);
  });
});

/** `s`, written to the steps table first, as the daemon writes each step before sending it. */
async function written(s: Step): Promise<Step> {
  await deps.db
    .insertInto('steps')
    .values({
      run_id: s.runId,
      seq: s.seq,
      kind: s.kind,
      input: s.input,
      output_trimmed: s.outputTrimmed,
      exit_code: s.exitCode,
      allowed: s.allowed,
      thought: s.thought,
      created_at: new Date(s.createdAt),
    })
    .execute();
  return s;
}

/** The daemon recorded as working `runId`. */
async function workedBy(runId: string): Promise<string | undefined> {
  const row = await deps.db
    .selectFrom('run_nodes')
    .select('node_name')
    .where('run_id', '=', runId)
    .executeTakeFirst();
  return row?.node_name;
}

describe('daemon names and node.updated', () => {
  const registry = app.get(Nodes);
  const nameOf = (socket: Socket) => registry.list().find((entry) => entry.id === socket.id)?.name;

  it('knows a daemon by the name it sends, and one without a valid name by its address', async () => {
    const named = await namedDaemon('railway-node');
    const unnamed = await daemon();
    const spaced = await connected(nodes.connect({ token: secret, name: 'my node' }));
    expect(nameOf(named)).toBe('railway-node');
    expect(nameOf(unnamed)).toMatch(/^unnamed-192\.0\.2\.\d+$/);
    expect(nameOf(spaced)).toMatch(/^unnamed-192\.0\.2\.\d+$/);
  });

  it('tells the tabs when a daemon connects, takes a run, lets it go and leaves', async () => {
    const { issueId, runId } = await fixing();
    const seen = await timeline('updates-node');
    const node = await namedDaemon('updates-node');
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]?.node).toMatchObject({ connected: true, current: [], lastRunAt: null });

    node.emit('node.step', { v: 1, step: await written(step(runId, 0, 'ls')) });
    await expect.poll(() => seen.length).toBe(4);
    // After the run's own events, so a tab has the step before the daemon's new run.
    expect(seen.map((s) => s.event)).toEqual([
      'node.updated updates-node',
      'run.started',
      'run.step',
      'node.updated updates-node',
    ]);
    expect(seen[3]?.node).toMatchObject({
      connected: true,
      lastRunAt: expect.any(String) as unknown,
      current: [
        {
          id: runId,
          issueId,
          issueTitle: 'Boom',
          tier: 1,
          status: 'running',
          stepCount: 1,
          lastStep: { seq: 0, input: 'ls' },
        },
      ],
    });

    // A later step of a run it holds already changes nothing node.updated carries.
    node.emit('node.step', { v: 1, step: await written(step(runId, 1)) });
    node.emit('node.run.finished', { ...nodeToServerEventFixtures['node.run.finished'], runId });
    await expect.poll(() => seen.length).toBe(7);
    expect(seen.slice(4).map((s) => s.event)).toEqual([
      'run.step',
      'run.finished',
      'node.updated updates-node',
    ]);
    expect(seen[6]?.node).toMatchObject({ connected: true, current: [] });

    node.close();
    await expect.poll(() => seen.length).toBe(8);
    expect(seen[7]?.node).toMatchObject({
      connected: false,
      since: expect.any(String) as unknown,
      current: [],
    });
  });

  it('records the daemon working each run, and moves the run to the one that names it last', async () => {
    const { runId } = await fixing();
    const first = await namedDaemon('first-node');
    first.emit('node.step', { v: 1, step: step(runId, 0) });
    await expect.poll(() => workedBy(runId)).toBe('first-node');

    const seen = await timeline('first-node');
    const second = await namedDaemon('second-node');
    second.emit('node.step', { v: 1, step: step(runId, 1) });
    await expect.poll(() => workedBy(runId)).toBe('second-node');
    // The daemon the run left is told it holds nothing now.
    await expect.poll(() => seen.at(-1)?.node?.current).toEqual([]);
  });

  it('counts sockets that share a name as one daemon', async () => {
    const { runId } = await fixing();
    const a = await namedDaemon('twin-node');
    const b = await namedDaemon('twin-node');
    b.emit('node.step', { v: 1, step: step(runId, 0) });
    await expect.poll(() => registry.state('twin-node').runIds).toEqual([runId]);
    expect(registry.state('twin-node').connected).toBe(true);
    expect(registry.names().filter((name) => name === 'twin-node')).toHaveLength(1);

    a.close();
    await expect.poll(() => registry.list().some((entry) => entry.id === a.id)).toBe(false);
    expect(registry.state('twin-node')).toMatchObject({ connected: true, runIds: [runId] });
    b.close();
    await expect.poll(() => registry.state('twin-node').connected).toBe(false);
    expect(registry.state('twin-node')).toMatchObject({
      runIds: [],
      since: expect.any(String) as unknown,
    });
    expect(registry.state('never-seen')).toEqual({ connected: false, since: null, runIds: [] });
  });
});

describe('Nodes', () => {
  const registry = app.get(Nodes);

  it('holds a run from its first event until it finishes or the daemon leaves', async () => {
    const first = await fixing();
    const second = await fixing();
    const node = await daemon();
    const other = await daemon();
    node.emit('node.step', { v: 1, step: step(first.runId, 0) });
    node.emit('node.diff', { v: 1, runId: second.runId, diff: '' });
    await expect.poll(() => registry.holder(second.runId)?.id).toBe(node.id);
    expect(registry.holder(first.runId)?.id).toBe(node.id);
    expect(registry.list().find((entry) => entry.id === node.id)).toMatchObject({
      address: expect.stringMatching(/^192\.0\.2\./) as unknown,
      runIds: [first.runId, second.runId],
    });

    node.emit('node.run.finished', {
      ...nodeToServerEventFixtures['node.run.finished'],
      runId: first.runId,
    });
    await expect.poll(() => registry.holder(first.runId)).toBeUndefined();

    // A run moves to the socket that names it last, as after a reconnect.
    other.emit('node.diff', { v: 1, runId: second.runId, diff: '' });
    await expect.poll(() => registry.holder(second.runId)?.id).toBe(other.id);
    expect(registry.list().find((entry) => entry.id === node.id)?.runIds).toEqual([]);

    other.close();
    await expect.poll(() => registry.holder(second.runId)).toBeUndefined();
    expect(registry.list().map((entry) => entry.id)).not.toContain(other.id);
  });
});

describe('kills', () => {
  const registry = app.get(Nodes);
  const api = { authorization: `Bearer ${testConfig.apiToken ?? ''}` };

  /** A daemon that has sent a run's first step, once the gateway has handled it. */
  async function holding(runId: string) {
    const seen = await tab();
    const node = await daemon();
    const killed = kills(node);
    node.emit('node.step', { v: 1, step: step(runId, 0) });
    await expect.poll(() => seen.some((s) => s.event === 'run.step')).toBe(true);
    expect(registry.holder(runId)?.id).toBe(node.id);
    return { node, killed };
  }

  it('sends run.kill to the daemon holding the run, and to no other', async () => {
    const a = await fixing();
    const b = await fixing();
    const nodeA = await holding(a.runId);
    const nodeB = await holding(b.runId);

    // The issue's kill event, as an operator sends it.
    const res = await app.inject({
      method: 'POST',
      url: `/issues/${a.issueId}/events`,
      headers: api,
      payload: { type: 'kill' },
    });
    expect(res.statusCode).toBe(200);
    await expect.poll(() => nodeA.killed).toEqual([a.runId]);

    // The UI's run.kill kills the issue too.
    const tabSocket = await ui();
    tabSocket.emit('run.kill', { v: 1, runId: b.runId });
    await expect.poll(() => nodeB.killed).toEqual([b.runId]);
    expect(nodeA.killed).toEqual([a.runId]);
    expect(await issues.get(b.issueId)).toMatchObject({ status: 'killed' });
  });

  it('kills the issue of a run no daemon holds, then the daemon once it names the run', async () => {
    const { issueId, runId } = await fixing();
    const tabSocket = await ui();
    tabSocket.emit('run.kill', { v: 1, runId });
    await expect.poll(async () => (await issues.get(issueId)).status).toBe('killed');
    const [job] = await deps.boss.findJobs(FIX_QUEUE, { id: runId });
    expect(job?.state).toBe('cancelled');

    // A daemon that was on the run while disconnected comes back and sends its next step.
    const node = await daemon();
    const killed = kills(node);
    node.emit('node.step', { v: 1, step: step(runId, 3) });
    await expect.poll(() => killed).toEqual([runId]);
    // Only on its first event for the run.
    node.emit('node.step', { v: 1, step: step(runId, 4) });
    node.emit('node.run.finished', {
      v: 1,
      runId,
      status: 'killed',
      prUrl: null,
      confidence: null,
      note: null,
    });
    await expect.poll(() => registry.holder(runId)).toBeUndefined();
    expect(killed).toEqual([runId]);
  });

  it('stops the run of an issue failed without a result, and not one that reported', async () => {
    const lost = await fixing();
    const reported = await fixing();
    const nodeLost = await holding(lost.runId);
    const nodeReported = await holding(reported.runId);
    const runs = app.get(RunsService);

    const job: FixJob = {
      v: 1,
      runId: lost.runId,
      issueId: lost.issueId,
      fingerprint: 'unused',
      tier: 1,
      report: 'unused',
    };
    await runs.recordLost(job, 'the job expired');
    await expect.poll(() => nodeLost.killed).toEqual([lost.runId]);

    nodeReported.node.emit('node.run.finished', {
      v: 1,
      runId: reported.runId,
      status: 'escalated',
      prUrl: null,
      confidence: null,
      reason: 'tests_failing',
      toTier: 2,
      note: escalationNoteFixture,
    });
    await expect.poll(() => registry.holder(reported.runId)).toBeUndefined();
    await runs.record({
      v: 1,
      issueId: reported.issueId,
      tier: 1,
      startedAt: stepFixture.createdAt,
      finishedAt: stepFixture.createdAt,
      diff: null,
      result: {
        v: 1,
        runId: reported.runId,
        status: 'escalated',
        prUrl: null,
        confidence: null,
        reason: 'tests_failing',
        toTier: 2,
        note: escalationNoteFixture,
      },
    });
    expect(await issues.get(reported.issueId)).toMatchObject({ status: 'fixing', currentTier: 2 });
    expect(nodeReported.killed).toEqual([]);
  });

  it('sends no run.kill for the buffered events of a run whose result was recorded', async () => {
    const { issueId, runId } = await fixing();
    // The daemon's result was recorded while its socket was away.
    await app.get(RunsService).record({
      v: 1,
      issueId,
      tier: 1,
      startedAt: stepFixture.createdAt,
      finishedAt: stepFixture.createdAt,
      diff: null,
      result: { v: 1, runId, status: 'failed', prUrl: null, confidence: null, note: null },
    });
    const seen = await tab();
    const node = await daemon();
    const killed = kills(node);
    node.emit('node.step', { v: 1, step: step(runId, 2) });
    await expect.poll(() => seen.length).toBe(1);
    expect(killed).toEqual([]);
  });

  it('drops a run.kill that breaks its contract, and leaves run.chat and approval.decide', async () => {
    const held = await fixing();
    const other = await fixing();
    const { killed } = await holding(held.runId);
    const tabSocket = await ui();
    tabSocket.emit('run.kill', { v: 1, runId: 'not-a-uuid' });
    tabSocket.emit('run.kill', { v: 2, runId: held.runId });
    tabSocket.emit('run.chat', { v: 1, runId: held.runId, message: 'Stop.' });
    tabSocket.emit('approval.decide', uiToServerEventFixtures['approval.decide']);
    // Handled after the ones above, since a socket's events arrive in order.
    tabSocket.emit('run.kill', { v: 1, runId: other.runId });
    await expect.poll(async () => (await issues.get(other.issueId)).status).toBe('killed');
    expect(await issues.get(held.issueId)).toMatchObject({ status: 'fixing' });
    expect(killed).toEqual([]);
  });

  it('sends a run.kill for a finished run only to a daemon still holding it', async () => {
    const { issueId, runId } = await fixing();
    const { killed } = await holding(runId);
    await issues.apply(issueId, { type: 'kill' });
    await expect.poll(() => killed).toEqual([runId]);
    // The tab didn't know yet: the issue is killed, so only the daemon hears again.
    const tabSocket = await ui();
    tabSocket.emit('run.kill', { v: 1, runId });
    await expect.poll(() => killed).toEqual([runId, runId]);
    // No daemon holds an unknown run, so nothing is sent.
    tabSocket.emit('run.kill', { v: 1, runId: randomUUID() });
    expect(await issues.get(issueId)).toMatchObject({ status: 'killed' });
  });
});
