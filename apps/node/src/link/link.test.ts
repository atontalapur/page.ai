import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nodeToServerEventFixtures, stepFixture } from '@page/contracts/fixtures';
import { pino } from 'pino';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLink } from './fake-link.ts';
import { NODE_NAMESPACE, SocketIoLink } from './socket-io-link.ts';

const logger = pino({ enabled: false });
const step = nodeToServerEventFixtures['node.step'];

describe('FakeLink', () => {
  it('records checked events by name', () => {
    const link = new FakeLink();
    link.send('node.step', step);
    link.send('node.diff', nodeToServerEventFixtures['node.diff']);
    expect(link.payloads('node.step')).toEqual([step]);
    expect(link.sent.map((s) => s.event)).toEqual(['node.step', 'node.diff']);
  });

  it('throws on a payload the contract rejects', () => {
    const link = new FakeLink();
    expect(() => link.send('node.step', { ...step, v: 2 as 1 })).toThrow();
    expect(link.sent).toEqual([]);
  });

  it('logs what it would send when given a logger', async () => {
    const lines: string[] = [];
    const link = new FakeLink(pino({}, { write: (line: string) => lines.push(line) }));
    link.send('node.step', step);
    await link.close();
    expect(link.closed).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'node.step' });
  });
});

describe('SocketIoLink', () => {
  let close = () => Promise.resolve();
  afterEach(() => close());

  async function orchestrator(secret: string) {
    const http = createServer();
    const server = new Server(http);
    const nodes = server.of(NODE_NAMESPACE);
    nodes.use((socket, next) => {
      const { token } = socket.handshake.auth as { token?: string };
      next(token === secret ? undefined : new Error('bad secret'));
    });
    http.listen(0);
    await once(http, 'listening');
    close = async () => {
      await server.close();
    };
    const { port } = http.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, nodes };
  }

  it('authenticates with the shared secret and delivers events', async () => {
    const { url, nodes } = await orchestrator('s3cret');
    const received = new Promise<unknown>((resolve) => {
      nodes.on('connection', (socket) => socket.on('node.step', resolve));
    });
    const link = new SocketIoLink({ url, secret: 's3cret', logger });
    link.send('node.step', step);
    expect(await received).toEqual({ v: 1, step: stepFixture });
    await link.close();
  });

  it('keeps events sent before it connects', async () => {
    const { url, nodes } = await orchestrator('s3cret');
    const link = new SocketIoLink({ url, secret: 's3cret', logger });
    link.send('node.step', step);
    link.send('node.diff', nodeToServerEventFixtures['node.diff']);
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      nodes.on('connection', (socket) =>
        socket.onAny((event: string) => {
          events.push(event);
          if (events.length === 2) resolve();
        }),
      );
    });
    expect(events).toEqual(['node.step', 'node.diff']);
    await link.close();
  });

  it('refuses to send a payload the contract rejects', async () => {
    const { url } = await orchestrator('s3cret');
    const link = new SocketIoLink({ url, secret: 's3cret', logger });
    expect(() => link.send('node.step', { v: 1, step: { ...stepFixture, seq: -1 } })).toThrow();
    await link.close();
  });

  it('is turned away with the wrong secret', async () => {
    const { url } = await orchestrator('s3cret');
    const lines: string[] = [];
    const link = new SocketIoLink({
      url,
      secret: 'wrong',
      logger: pino({}, { write: (line: string) => lines.push(line) }),
    });
    await expect.poll(() => lines.join('')).toContain('cannot reach the orchestrator');
    expect(lines.join('')).toContain('bad secret');
    await link.close();
  });
});
