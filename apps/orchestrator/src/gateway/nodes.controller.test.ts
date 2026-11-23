import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  NODE_NAMESPACE,
  nodeRunSchema,
  nodeSummarySchema,
  type NodeRun,
  type NodeSummary,
  type Step,
} from '@page/contracts';
import { escalationNoteFixture, stepFixture } from '@page/contracts/fixtures';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { NodeRuns } from '../runs/node-runs.ts';
import { RunsService } from '../runs/runs.service.ts';
import { DEFAULT_NODE_RUNS, MAX_NODE_RUNS, NODE_REQUESTS_PER_MINUTE } from './nodes.controller.ts';
import { outcome, TestSockets } from './test-utils.ts';

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(deps, false);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = await app.getUrl();
afterAll(async () => {
  await app.close();
  await deps.close();
});

const sockets = new TestSockets(`${base}${NODE_NAMESPACE}`, '192.0.2');
afterEach(() => sockets.closeAll());

const issues = app.get(IssuesService);
const nodeRuns = app.get(NodeRuns);
const api = { authorization: `Bearer ${testConfig.apiToken ?? ''}` };
let addresses = 0;

/** A GET with the token, from an address of its own so the rate limit counts it apart. */
function get(url: string, address = `198.51.100.${++addresses}`) {
  return app.inject({ method: 'GET', url, headers: { ...api, 'x-forwarded-for': address } });
}

const summaries = async (): Promise<NodeSummary[]> => {
  const res = await get('/nodes');
  expect(res.statusCode).toBe(200);
  return nodeSummarySchema.array().parse(res.json());
};

const runsOf = async (name: string, query = ''): Promise<NodeRun[]> => {
  const res = await get(`/nodes/${name}/runs${query}`);
  expect(res.statusCode).toBe(200);
  return nodeRunSchema.array().parse(res.json());
};

let n = 0;

/** An issue in `fixing` at tier 1, and its run. */
async function fixing(title = 'Boom'): Promise<{ issueId: string; runId: string }> {
  const { issue } = await issues.report({ fingerprint: `nodes-route-${++n}`, title });
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  const started = await issues.apply(issue.id, { type: 'start_fix' });
  const row = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', started.id)
    .executeTakeFirstOrThrow();
  return { issueId: issue.id, runId: row.current_run_id ?? '' };
}

async function wrote(runId: string, seq: number, input = `cmd ${seq}`): Promise<Step> {
  const s: Step = { ...stepFixture, runId, seq, input };
  await deps.db
    .insertInto('steps')
    .values({
      run_id: runId,
      seq,
      kind: s.kind,
      input,
      output_trimmed: s.outputTrimmed,
      exit_code: s.exitCode,
      allowed: s.allowed,
      thought: s.thought,
      created_at: new Date(s.createdAt),
    })
    .execute();
  return s;
}

async function connected(name: string) {
  const socket = sockets.connect({ token: testConfig.nodeSharedSecret, name });
  expect(await outcome(socket)).toBe('connected');
  return socket;
}

describe('the node routes', () => {
  it('need the API token', async () => {
    for (const url of ['/nodes', '/nodes/railway-node/runs']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('refuse a name a daemon cannot have, and a limit out of range', async () => {
    expect((await get('/nodes/my%20node/runs')).statusCode).toBe(400);
    expect((await get('/nodes/-node/runs')).statusCode).toBe(400);
    expect((await get('/nodes/railway-node/runs?limit=0')).statusCode).toBe(400);
    const over = `/nodes/railway-node/runs?limit=${MAX_NODE_RUNS + 1}`;
    expect((await get(over)).statusCode).toBe(400);
    expect((await get(`/nodes/railway-node/runs?limit=${MAX_NODE_RUNS}`)).statusCode).toBe(200);
    expect((await get('/nodes/railway-node/runs?limit=two')).statusCode).toBe(400);
  });

  it(`answer 429 with Retry-After past ${NODE_REQUESTS_PER_MINUTE} a minute from one address`, async () => {
    const address = '203.0.113.77';
    for (let i = 0; i < NODE_REQUESTS_PER_MINUTE; i++) {
      const url = i % 2 === 0 ? '/nodes' : '/nodes/railway-node/runs';
      expect((await get(url, address)).statusCode).toBe(200);
    }
    const limited = await get('/nodes', address);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect((await get('/nodes/railway-node/runs', address)).statusCode).toBe(429);
    // Another address is counted apart, and a request without the token gets its 401 first.
    expect((await get('/nodes')).statusCode).toBe(200);
    const anonymous = await app.inject({
      method: 'GET',
      url: '/nodes',
      headers: { 'x-forwarded-for': address },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('GET /nodes', () => {
  it('lists a connected daemon with the run it holds, one that left, and one known from its runs', async () => {
    const { issueId, runId } = await fixing('TypeError: boom');
    await wrote(runId, 0, 'ls');
    const live = await connected('live-node');
    live.emit('node.step', { v: 1, step: await wrote(runId, 1, 'pnpm test') });
    await expect
      .poll(async () => (await summaries()).find((s) => s.name === 'live-node')?.current.length)
      .toBe(1);

    const gone = await connected('gone-node');
    gone.close();
    await expect
      .poll(async () => (await summaries()).find((s) => s.name === 'gone-node')?.connected)
      .toBe(false);
    const past = await fixing();
    await nodeRuns.record(past.runId, 'past-node');

    const all = await summaries();
    const names = all.map((s) => s.name);
    expect(names).toEqual([...names].sort());
    expect(all.find((s) => s.name === 'live-node')).toMatchObject({
      connected: true,
      since: expect.any(String) as unknown,
      lastRunAt: expect.any(String) as unknown,
      current: [
        {
          id: runId,
          issueId,
          issueTitle: 'TypeError: boom',
          tier: 1,
          status: 'running',
          startedAt: stepFixture.createdAt,
          stepCount: 2,
          lastStep: { seq: 1, input: 'pnpm test' },
        },
      ],
    });
    expect(all.find((s) => s.name === 'gone-node')).toMatchObject({
      connected: false,
      since: expect.any(String) as unknown,
      current: [],
      lastRunAt: null,
    });
    expect(all.find((s) => s.name === 'past-node')).toMatchObject({
      connected: false,
      since: null,
      current: [],
      lastRunAt: expect.any(String) as unknown,
    });
  });
});

describe('GET /nodes/:name/runs', () => {
  it("lists the daemon's runs, the one it took last first, as each stands", async () => {
    const node = 'history-node';
    const recorded = await fixing('Recorded');
    await nodeRuns.record(recorded.runId, node);
    await wrote(recorded.runId, 0);
    await app.get(RunsService).record({
      v: 1,
      issueId: recorded.issueId,
      tier: 1,
      startedAt: '2026-11-22T09:00:00.000Z',
      finishedAt: '2026-11-22T09:03:00.000Z',
      diff: null,
      result: {
        v: 1,
        runId: recorded.runId,
        status: 'escalated',
        prUrl: null,
        confidence: null,
        reason: 'tests_failing',
        toTier: 2,
        note: escalationNoteFixture,
      },
    });
    const killed = await fixing('Killed');
    await nodeRuns.record(killed.runId, node);
    await issues.apply(killed.issueId, { type: 'kill' });
    const queued = await fixing('Queued');
    await nodeRuns.record(queued.runId, node);
    const running = await fixing('Running');
    await nodeRuns.record(running.runId, node);
    await wrote(running.runId, 0);
    await wrote(running.runId, 1, 'cat -n src/app.ts');
    // A run no issue or row knows, such as one a new tier replaced before it reported.
    await nodeRuns.record(randomUUID(), node);

    const runs = await runsOf(node);
    expect(runs.map((r) => [r.issueTitle, r.status, r.stepCount])).toEqual([
      ['Running', 'running', 2],
      ['Queued', 'queued', 0],
      ['Killed', 'killed', 0],
      ['Recorded', 'escalated', 1],
    ]);
    expect(runs[0]).toMatchObject({
      issueId: running.issueId,
      startedAt: stepFixture.createdAt,
      finishedAt: null,
      lastStep: { seq: 1, input: 'cat -n src/app.ts' },
    });
    expect(runs[1]).toMatchObject({ startedAt: null, lastStep: null });
    expect(runs[3]).toMatchObject({
      id: recorded.runId,
      tier: 1,
      startedAt: '2026-11-22T09:00:00.000Z',
      finishedAt: '2026-11-22T09:03:00.000Z',
    });

    expect((await runsOf(node, '?limit=2')).map((r) => r.issueTitle)).toEqual([
      'Running',
      'Queued',
    ]);
    expect(await runsOf('nobody-node')).toEqual([]);
  });

  it(`returns at most ${DEFAULT_NODE_RUNS} runs by default`, async () => {
    const node = 'busy-node';
    for (let i = 0; i <= DEFAULT_NODE_RUNS; i++) {
      const { runId } = await fixing();
      await nodeRuns.record(runId, node);
    }
    expect(await runsOf(node)).toHaveLength(DEFAULT_NODE_RUNS);
  });
});
