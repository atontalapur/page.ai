import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  NODE_NAMESPACE,
  serverToNodeEvents,
  serverToUiEvents,
  UI_NAMESPACE,
  type PendingChat,
  type ServerToNodeEvents,
} from '@page/contracts';
import { stepFixture } from '@page/contracts/fixtures';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { hashToken } from '../auth/dashboard-tokens.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { Nodes } from '../gateway/nodes.ts';
import { outcome, TestSockets } from '../gateway/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';

// Who a message is recorded under once personal dashboard tokens are configured: the person
// a token names, as for a Tier 3 decision. chats.test.ts covers the name labels, which hold
// only while no personal token is configured.

const arjunToken = 'arjun-personal-token';
const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(
  {
    ...deps,
    config: {
      ...testConfig,
      dashboardTokens: [{ name: 'Arjun', sha256: hashToken(arjunToken) }],
    },
  },
  false,
);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = await app.getUrl();
afterAll(async () => {
  await app.close();
  await deps.close();
});

const nodeSockets = new TestSockets(`${base}${NODE_NAMESPACE}`, '192.0.2');
const tabs = new TestSockets(`${base}${UI_NAMESPACE}`, '203.0.113');
afterEach(() => {
  nodeSockets.closeAll();
  tabs.closeAll();
});

const issues = app.get(IssuesService);

async function connected(socket: Socket): Promise<Socket> {
  expect(await outcome(socket)).toBe('connected');
  return socket;
}

/** An issue in `fixing`, its run, and a daemon holding the run with the messages it gets. */
async function held() {
  const { issue } = await issues.report(
    { fingerprint: `chat-identity-${Date.now()}-${Math.random()}`, title: 'Boom' },
    'GET /\n\nTypeError: boom',
  );
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const { current_run_id: runId } = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', issue.id)
    .executeTakeFirstOrThrow();
  const daemon = await connected(nodeSockets.connect({ token: testConfig.nodeSharedSecret }));
  const got: Parameters<ServerToNodeEvents['run.chat']>[0][] = [];
  daemon.on('run.chat', (p: unknown) => got.push(serverToNodeEvents['run.chat'].parse(p)));
  daemon.emit('node.step', { v: 1, step: { ...stepFixture, runId, seq: 0 } });
  await expect.poll(() => app.get(Nodes).holder(runId!)).toBeDefined();
  return { runId: runId!, got };
}

describe('run chat with personal tokens configured', () => {
  it("records a personal token's message as its person, whatever name the tab sends", async () => {
    const { runId, got } = await held();
    const tab = await connected(tabs.connect({ token: arjunToken, name: 'Daniyal' }));
    const asked: PendingChat[] = [];
    tab.on('run.chat.asked', (p: unknown) =>
      asked.push(serverToUiEvents['run.chat.asked'].parse(p).chat),
    );
    tab.emit('run.chat', { v: 1, runId, message: 'Why that file?' });
    await expect.poll(() => got).toMatchObject([{ runId, from: 'Arjun' }]);
    await expect.poll(() => asked).toMatchObject([{ runId, askedBy: 'ui:Arjun' }]);
  });

  it('refuses the shared token, even with a name, and sends nothing on', async () => {
    const { runId, got } = await held();
    const tab = await connected(tabs.connect({ token: testConfig.apiToken, name: 'Daniyal' }));
    const refused: string[] = [];
    tab.on('run.chat.refused', (p: unknown) =>
      refused.push(serverToUiEvents['run.chat.refused'].parse(p).reason),
    );
    tab.emit('run.chat', { v: 1, runId, message: 'Why that file?' });
    await expect.poll(() => refused).toEqual(['no_name']);
    expect(got).toEqual([]);
  });
});
