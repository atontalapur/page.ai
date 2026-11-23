import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { serverToUiEvents, UI_NAMESPACE, type Issue } from '@page/contracts';
import { posthogWebhookFixture } from '@page/contracts/fixtures';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { TriageService } from '../triage/triage.service.ts';
import { outcome, TestSockets } from './test-utils.ts';
import { HANDSHAKES_PER_MINUTE, MESSAGES_PER_10_SECONDS } from './ui.gateway.ts';

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(deps, false);
await app.listen({ port: 0, host: '127.0.0.1' });
const url = `${await app.getUrl()}${UI_NAMESPACE}`;
afterAll(async () => {
  await app.close();
  await deps.close();
});

const token = testConfig.apiToken ?? '';
const api = { authorization: `Bearer ${token}` };
const sockets = new TestSockets(url, '203.0.113');
afterEach(() => sockets.closeAll());
const connect = sockets.connect.bind(sockets);

/** The next `issue.updated` payloads, checked against the contract as the UI checks them. */
function updates(socket: Socket, count: number): Promise<Issue[]> {
  const issues: Issue[] = [];
  return new Promise((resolve) => {
    socket.on('issue.updated', (payload: unknown) => {
      issues.push(serverToUiEvents['issue.updated'].parse(payload).issue);
      if (issues.length === count) resolve(issues);
    });
  });
}

async function live(): Promise<Socket> {
  const socket = connect({ token });
  expect(await outcome(socket)).toBe('connected');
  return socket;
}

describe('UI socket', () => {
  it('refuses a handshake without the API token or with a wrong one', async () => {
    expect(await outcome(connect({}))).toBe('unauthorized');
    expect(await outcome(connect({ token: 'wrong' }))).toBe('unauthorized');
    expect(await outcome(connect({ token: `Bearer ${token}` }))).toBe('unauthorized');
    expect(await outcome(connect({ token }))).toBe('connected');
  });

  it('sends issue.updated when an issue is opened, repeated or moved', async () => {
    const socket = await live();
    const received = updates(socket, 3);
    const created = await app.inject({
      method: 'POST',
      url: '/issues',
      headers: api,
      payload: { fingerprint: 'gateway-1', title: 'Boom' },
    });
    const { issue } = created.json<{ issue: Issue }>();
    await app.inject({
      method: 'POST',
      url: '/issues',
      headers: api,
      payload: { fingerprint: 'gateway-1', title: 'Boom' },
    });
    await app.inject({
      method: 'POST',
      url: `/issues/${issue.id}/events`,
      headers: api,
      payload: { type: 'kill' },
    });
    const [opened, repeated, killed] = await received;
    expect(opened).toEqual(issue);
    expect(repeated).toMatchObject({ id: issue.id, occurrences: 2, status: 'new' });
    expect(killed).toMatchObject({ id: issue.id, status: 'killed' });
  });

  it('sends issue.updated for a webhook and for its triage', async () => {
    const socket = await live();
    const received = updates(socket, 2);
    const ingested = await app.inject({
      method: 'POST',
      url: '/ingest/posthog',
      headers: { authorization: `Bearer ${testConfig.posthogWebhookSecret ?? ''}` },
      payload: posthogWebhookFixture,
    });
    const { issue } = ingested.json<{ issue: Issue }>();
    await app.get(TriageService).handle({ v: 1, issueId: issue.id });
    const [opened, triaged] = await received;
    expect(opened).toMatchObject({ id: issue.id, status: 'new' });
    expect(triaged).toMatchObject({ id: issue.id, status: 'triaged' });
    expect(triaged?.severity).not.toBeNull();
  });

  it('sends nothing to a socket it refused', async () => {
    const refused = connect({ token: 'wrong' });
    const seen: unknown[] = [];
    refused.on('issue.updated', (payload: unknown) => seen.push(payload));
    expect(await outcome(refused)).toBe('unauthorized');
    const watcher = await live();
    const received = updates(watcher, 1);
    await app.inject({
      method: 'POST',
      url: '/issues',
      headers: api,
      payload: { fingerprint: 'gateway-2', title: 'Boom' },
    });
    await received;
    expect(seen).toEqual([]);
  });

  it(`refuses an address's handshakes past ${HANDSHAKES_PER_MINUTE} a minute`, async () => {
    const address = '198.51.100.7';
    for (let i = 0; i < HANDSHAKES_PER_MINUTE; i++) {
      expect(await outcome(connect({ token: 'wrong' }, address))).toBe('unauthorized');
    }
    // Even with the right token: the limit runs first, so guessing stays bounded.
    expect(await outcome(connect({ token }, address))).toBe('rate_limited');
    expect(await outcome(connect({ token }))).toBe('connected');
  });

  it(`closes a socket that sends more than ${MESSAGES_PER_10_SECONDS} messages in 10s`, async () => {
    const socket = await live();
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    for (let i = 0; i <= MESSAGES_PER_10_SECONDS; i++) socket.emit('run.chat', { v: 1 });
    expect(await closed).toBe('io server disconnect');
  });
});
