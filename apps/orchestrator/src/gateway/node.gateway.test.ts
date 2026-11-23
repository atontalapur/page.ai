import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  NODE_NAMESPACE,
  serverToUiEvents,
  UI_NAMESPACE,
  type ServerToUiEvents,
  type Step,
} from '@page/contracts';
import {
  escalationNoteFixture,
  nodeToServerEventFixtures,
  stepFixture,
} from '@page/contracts/fixtures';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
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

type UiEvent = keyof ServerToUiEvents;

/** Every run event a tab gets, each parsed against its contract as the UI parses it. */
async function tab() {
  const socket = await connected(tabs.connect({ token: testConfig.apiToken }));
  const seen: { event: UiEvent; ok: boolean; payload: unknown }[] = [];
  socket.onAny((event: UiEvent, payload: unknown) => {
    if (event === 'issue.updated') return;
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
