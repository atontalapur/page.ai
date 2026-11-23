import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { NODE_NAMESPACE, UI_NAMESPACE } from '@page/contracts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { NODE_HANDSHAKES_PER_MINUTE, NODE_MESSAGES_PER_10_SECONDS } from './node.gateway.ts';
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
afterEach(() => nodes.closeAll());

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
    const ui = new TestSockets(`${base}${UI_NAMESPACE}`, '192.0.2');
    expect(await outcome(ui.connect({ token: secret }, '198.51.100.20'))).toBe('unauthorized');
    ui.closeAll();
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
    const socket = nodes.connect({ token: secret });
    expect(await outcome(socket)).toBe('connected');
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    for (let i = 0; i <= NODE_MESSAGES_PER_10_SECONDS; i++) socket.emit('node.diff', { v: 1 });
    expect(await closed).toBe('io server disconnect');
  });
});
