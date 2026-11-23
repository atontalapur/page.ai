import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NODE_NAMESPACE } from '@page/contracts';
import {
  nodeToServerEventFixtures,
  serverToNodeEventFixtures,
  stepFixture,
} from '@page/contracts/fixtures';
import { pino } from 'pino';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLink } from './fake-link.ts';
import { SocketIoLink } from './socket-io-link.ts';

const logger = pino({ enabled: false });
const step = nodeToServerEventFixtures['node.step'];
const kill = serverToNodeEventFixtures['run.kill'];

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

  it('delivers server events to their handlers', () => {
    const link = new FakeLink();
    const kills: unknown[] = [];
    link.on('run.kill', (payload) => kills.push(payload));
    link.deliver('run.kill', kill);
    link.deliver('run.chat', serverToNodeEventFixtures['run.chat']);
    expect(kills).toEqual([kill]);
  });

  it('drops and logs a server event the contract rejects', () => {
    const lines: string[] = [];
    const link = new FakeLink(pino({}, { write: (line: string) => lines.push(line) }));
    const kills: unknown[] = [];
    link.on('run.kill', (payload) => kills.push(payload));
    link.deliver('run.kill', { ...kill, runId: 'not-a-uuid' });
    expect(kills).toEqual([]);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'run.kill', level: 40 });
  });

  it('plays a reconnect to its handlers', () => {
    const link = new FakeLink();
    let reconnects = 0;
    link.onReconnect(() => reconnects++);
    link.reconnect();
    expect(reconnects).toBe(1);
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

  /** A stand-in for the orchestrator's /node namespace, on `port` when given. */
  async function orchestrator(secret: string, port = 0) {
    const http = createServer();
    const server = new Server(http);
    const nodes = server.of(NODE_NAMESPACE);
    nodes.use((socket, next) => {
      const { token } = socket.handshake.auth as { token?: string };
      next(token === secret ? undefined : new Error('bad secret'));
    });
    http.listen(port);
    await once(http, 'listening');
    const stop = async () => {
      await server.close();
    };
    close = stop;
    const address = http.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}`, port: address.port, nodes, stop };
  }

  const fast = { refusedMs: 50, closedMs: 50 };

  it('authenticates with the shared secret and delivers events', async () => {
    const { url, nodes } = await orchestrator('s3cret');
    const received = new Promise<unknown>((resolve) => {
      nodes.on('connection', (socket) => socket.on('node.step', resolve));
    });
    const link = new SocketIoLink({ url, secret: 's3cret', name: 'test-node', logger });
    link.send('node.step', step);
    expect(await received).toEqual({ v: 1, step: stepFixture });
    await link.close();
  });

  it('sends its name in the handshake, beside the secret', async () => {
    const { url, nodes } = await orchestrator('s3cret');
    const auth = new Promise<unknown>((resolve) => {
      nodes.on('connection', (socket) => resolve(socket.handshake.auth));
    });
    const link = new SocketIoLink({ url, secret: 's3cret', name: 'railway-node', logger });
    expect(await auth).toEqual({ token: 's3cret', name: 'railway-node' });
    await link.close();
  });

  it('keeps events sent before it connects', async () => {
    const { url, nodes } = await orchestrator('s3cret');
    const link = new SocketIoLink({ url, secret: 's3cret', name: 'test-node', logger });
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

  it('passes server events that match the contract to their handlers', async () => {
    const { url, nodes } = await orchestrator('s3cret');
    nodes.on('connection', (socket) => {
      socket.emit('run.kill', { ...kill, runId: 'not-a-uuid' });
      socket.emit('run.kill', kill);
    });
    const link = new SocketIoLink({ url, secret: 's3cret', name: 'test-node', logger });
    const kills: unknown[] = [];
    link.on('run.kill', (payload) => kills.push(payload));
    await expect.poll(() => kills).toEqual([kill]);
    await link.close();
  });

  it('refuses to send a payload the contract rejects', async () => {
    const { url } = await orchestrator('s3cret');
    const link = new SocketIoLink({ url, secret: 's3cret', name: 'test-node', logger });
    expect(() => link.send('node.step', { v: 1, step: { ...stepFixture, seq: -1 } })).toThrow();
    await link.close();
  });

  it('is turned away with the wrong secret, and tries again later', async () => {
    const { url } = await orchestrator('s3cret');
    const lines: string[] = [];
    const link = new SocketIoLink({
      url,
      secret: 'wrong',
      name: 'test-node',
      logger: pino({}, { write: (line: string) => lines.push(line) }),
      retry: fast,
    });
    await expect.poll(() => lines.join('')).toContain('the orchestrator refused the socket');
    expect(lines.join('')).toContain('bad secret');
    // socket.io-client gives up on a refusal; the link asks again.
    await expect.poll(() => lines.filter((l) => l.includes('refused')).length).toBeGreaterThan(2);
    await link.close();
  });

  it('connects once the orchestrator stops refusing it', async () => {
    const { url, nodes } = await orchestrator('s3cret');
    let refusals = 2;
    nodes.use((_socket, next) => next(refusals-- > 0 ? new Error('rate_limited') : undefined));
    const received = new Promise<unknown>((resolve) => {
      nodes.on('connection', (socket) => socket.on('node.step', resolve));
    });
    const link = new SocketIoLink({
      url,
      secret: 's3cret',
      name: 'test-node',
      logger,
      retry: fast,
    });
    // Sent while refused, and kept until the link connects.
    link.send('node.step', step);
    expect(await received).toEqual(step);
    await link.close();
  });

  it('connects again after the orchestrator closes the socket, and says so', async () => {
    const { url, nodes } = await orchestrator('s3cret');
    let connections = 0;
    nodes.on('connection', (socket) => {
      connections++;
      if (connections === 1) socket.disconnect(true);
    });
    const link = new SocketIoLink({
      url,
      secret: 's3cret',
      name: 'test-node',
      logger,
      retry: fast,
    });
    let reconnects = 0;
    link.onReconnect(() => reconnects++);
    await expect.poll(() => connections).toBe(2);
    // The first connection isn't a reconnect; the second is.
    await expect.poll(() => reconnects).toBe(1);
    await link.close();
  });

  it('connects again after the orchestrator restarts', async () => {
    const first = await orchestrator('s3cret');
    const link = new SocketIoLink({
      url: first.url,
      secret: 's3cret',
      name: 'test-node',
      logger,
      retry: fast,
    });
    await once(first.nodes, 'connection');
    await first.stop();
    const second = await orchestrator('s3cret', first.port);
    const kills: unknown[] = [];
    link.on('run.kill', (payload) => kills.push(payload));
    const [socket] = (await once(second.nodes, 'connection')) as [
      { emit(e: string, p: unknown): void },
    ];
    socket.emit('run.kill', kill);
    await expect.poll(() => kills).toEqual([kill]);
    await link.close();
  });

  it('stops trying once closed', async () => {
    const { url, nodes } = await orchestrator('s3cret');
    let handshakes = 0;
    nodes.use((_socket, next) => {
      handshakes++;
      next(new Error('rate_limited'));
    });
    const link = new SocketIoLink({
      url,
      secret: 's3cret',
      name: 'test-node',
      logger,
      retry: fast,
    });
    await expect.poll(() => handshakes).toBe(1);
    await link.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(handshakes).toBe(1);
  });
});
