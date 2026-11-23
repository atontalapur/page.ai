import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  approvalSchema,
  NODE_NAMESPACE,
  serverToNodeEvents,
  serverToUiEvents,
  sessionSchema,
  UI_NAMESPACE,
  type Approval,
  type DecidedApproval,
} from '@page/contracts';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { outcome, TestSockets } from '../gateway/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { hashToken } from './dashboard-tokens.ts';

// The orchestrator with personal tokens configured, next to one with none, which keeps the
// shared token's name labels. approvals.test.ts covers the labels in depth.

const arjunToken = 'arjun-personal-token';
const daniyalToken = 'daniyal-personal-token';
const shared = testConfig.apiToken!;

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(
  {
    ...deps,
    config: {
      ...testConfig,
      dashboardTokens: [
        { name: 'Arjun', sha256: hashToken(arjunToken) },
        { name: 'Daniyal', sha256: hashToken(daniyalToken) },
      ],
    },
  },
  false,
);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = await app.getUrl();

const labelDeps = await createTestDeps();
const labelApp: NestFastifyApplication = await createApp(labelDeps, false);
await labelApp.init();
await labelApp.getHttpAdapter().getInstance().ready();

afterAll(async () => {
  await app.close();
  await labelApp.close();
  await deps.close();
  await labelDeps.close();
});

const tabs = new TestSockets(`${base}${UI_NAMESPACE}`, '203.0.113');
const nodes = new TestSockets(`${base}${NODE_NAMESPACE}`, '192.0.2');
afterEach(() => {
  tabs.closeAll();
  nodes.closeAll();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function me(on: NestFastifyApplication, token: string) {
  const res = await on.inject({ method: 'GET', url: '/me', headers: bearer(token) });
  expect(res.statusCode).toBe(200);
  return sessionSchema.parse(res.json());
}

async function connected(socket: Socket): Promise<Socket> {
  expect(await outcome(socket)).toBe('connected');
  return socket;
}

const issues = app.get(IssuesService);
let n = 0;

/** A daemon asked for approval of a call on a run in progress; `tab` is watching. */
async function asked(tab: Socket) {
  const { issue } = await issues.report({ fingerprint: `personal-${++n}`, title: 'Boom' });
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const { current_run_id: runId } = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', issue.id)
    .executeTakeFirstOrThrow();
  const requested: Approval[] = [];
  tab.on('approval.requested', (payload: unknown) =>
    requested.push(serverToUiEvents['approval.requested'].parse(payload).approval),
  );
  const node = await connected(nodes.connect({ token: testConfig.nodeSharedSecret }));
  const decided: DecidedApproval[] = [];
  node.on('approval.decided', (payload: unknown) =>
    decided.push(serverToNodeEvents['approval.decided'].parse(payload).approval),
  );
  const approvalId = randomUUID();
  node.emit('node.approval.request', {
    v: 1,
    approvalId,
    runId,
    action: 'ops.restart',
    args: { tool: 'ops.restart' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await expect.poll(() => requested.length).toBe(1);
  return { issueId: issue.id, approvalId, decided };
}

const row = (id: string) =>
  deps.db.selectFrom('approvals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('GET /me', () => {
  it('names the person a personal token belongs to', async () => {
    expect(await me(app, arjunToken)).toEqual({ token: 'personal', name: 'Arjun' });
    expect(await me(app, daniyalToken)).toEqual({ token: 'personal', name: 'Daniyal' });
  });

  it('says the shared token may not decide once personal tokens exist, and may without them', async () => {
    expect(await me(app, shared)).toEqual({ token: 'shared', canDecide: false });
    expect(await me(labelApp, shared)).toEqual({ token: 'shared', canDecide: true });
  });

  it('refuses a personal token on an orchestrator that has none configured', async () => {
    const res = await labelApp.inject({ method: 'GET', url: '/me', headers: bearer(arjunToken) });
    expect(res.statusCode).toBe(401);
  });
});

describe('a personal token', () => {
  it('opens the API and the socket as the shared token does', async () => {
    for (const token of [arjunToken, shared]) {
      const res = await app.inject({ method: 'GET', url: '/issues', headers: bearer(token) });
      expect(res.statusCode).toBe(200);
      await connected(tabs.connect({ token }));
    }
    expect(await outcome(tabs.connect({ token: hashToken(arjunToken) }))).toBe('unauthorized');
  });

  it('decides as the person it names, whatever name the tab sends', async () => {
    const arjun = await connected(tabs.connect({ token: arjunToken, name: 'Daniyal' }));
    const { approvalId, decided } = await asked(arjun);
    arjun.emit('approval.decide', { v: 1, approvalId, decision: 'approved' });
    await expect.poll(() => decided).toMatchObject([{ id: approvalId, decidedBy: 'ui:Arjun' }]);
    expect(await row(approvalId)).toMatchObject({ decision: 'approved', decided_by: 'ui:Arjun' });
  });
});

describe('the shared token, once personal tokens exist', () => {
  it('sees requests and lists them, but its decisions are dropped', async () => {
    const watcher = await connected(tabs.connect({ token: shared, name: 'Nidheesh' }));
    const { issueId, approvalId, decided } = await asked(watcher);
    watcher.emit('approval.decide', { v: 1, approvalId, decision: 'approved' });

    const listed = await app.inject({
      method: 'GET',
      url: `/approvals?issueId=${issueId}`,
      headers: bearer(shared),
    });
    expect(approvalSchema.array().parse(listed.json())).toMatchObject([
      { id: approvalId, decision: 'pending' },
    ]);
    // A person decides after it, so the shared token's decision was handled and dropped.
    const daniyal = await connected(tabs.connect({ token: daniyalToken }));
    daniyal.emit('approval.decide', { v: 1, approvalId, decision: 'rejected' });
    await expect.poll(() => decided).toMatchObject([{ decidedBy: 'ui:Daniyal' }]);
    expect(await row(approvalId)).toMatchObject({ decision: 'rejected', decided_by: 'ui:Daniyal' });
  });
});
