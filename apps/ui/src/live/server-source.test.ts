import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  issueFixture,
  nodeRunFixture,
  nodeSummaryFixture,
  runFixture,
  serverToUiEventFixtures,
  stepFixture,
} from '@page/contracts/fixtures';
import type { Issue, NodeSummary } from '@page/contracts';

import { RUN_EVENTS, type FeedStatus, type IssueFeed, type RunEvent } from './source';

type Handler = (arg?: unknown) => void;

/** Plays the socket.io-client socket the source opens. */
class FakeSocket {
  handlers = new Map<string, Handler>();
  connects = 0;
  closed = false;
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  fire(event: string, arg?: unknown) {
    this.handlers.get(event)?.(arg);
  }
  connect() {
    this.connects += 1;
  }
  close() {
    this.closed = true;
  }
}

const sockets: FakeSocket[] = [];
const io = vi.fn<(url: string, options: unknown) => FakeSocket>(() => {
  const socket = new FakeSocket();
  sockets.push(socket);
  return socket;
});
vi.mock('socket.io-client', () => ({ io: (url: string, options: unknown) => io(url, options) }));

const { serverPresent, serverSource } = await import('./server-source');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
// What GET /nodes answers, unless a test queues something else.
let nodesBody: unknown[] = [];
beforeEach(() => {
  nodesBody = [];
  fetchMock = vi.fn((url: string) =>
    Promise.resolve(json(url === '/nodes' ? nodesBody : [issueFixture])),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  sockets.length = 0;
  io.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function recorder() {
  const statuses: FeedStatus[] = [];
  const lists: Issue[][] = [];
  const updates: Issue[] = [];
  const runs: RunEvent[] = [];
  const nodeLists: NodeSummary[][] = [];
  const nodes: NodeSummary[] = [];
  // Every feed call in order, for the ones whose order matters.
  const calls: string[] = [];
  let syncs = 0;
  const feed: IssueFeed = {
    status: (status) => statuses.push(status),
    reset: (issues) => lists.push(issues),
    update: (issue) => updates.push(issue),
    synced: () => {
      syncs += 1;
    },
    run: (event) => runs.push(event),
    resetNodes: (list) => {
      calls.push('resetNodes');
      nodeLists.push(list);
    },
    node: (node) => {
      calls.push(`node ${node.name}`);
      nodes.push(node);
    },
  };
  return { feed, statuses, lists, updates, runs, nodeLists, nodes, calls, syncs: () => syncs };
}

describe('serverSource', () => {
  it('connects to /ui with the token, then loads the list with it', async () => {
    const { feed, statuses, lists } = recorder();
    serverSource('s3cret').start(feed);

    expect(io).toHaveBeenCalledWith('/ui', { auth: { token: 's3cret' } });
    expect(statuses).toEqual(['connecting']);
    sockets[0]!.fire('connect');

    await vi.waitFor(() => expect(lists).toEqual([[issueFixture]]));
    expect(statuses).toEqual(['connecting', 'live']);
    expect(fetchMock).toHaveBeenCalledWith('/issues', {
      headers: { authorization: 'Bearer s3cret', accept: 'application/json' },
    });
  });

  it('passes on issue.updated payloads that meet the contract, and drops the rest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { feed, updates } = recorder();
    serverSource('s3cret').start(feed);
    const socket = sockets[0]!;

    socket.fire('issue.updated', { v: 1, issue: issueFixture });
    socket.fire('issue.updated', { v: 2, issue: issueFixture });
    socket.fire('issue.updated', { v: 1, issue: { ...issueFixture, status: 'done' } });

    expect(updates).toEqual([issueFixture]);
  });

  it('passes on run events that meet the contract, by name, and drops the rest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { feed, runs } = recorder();
    serverSource('s3cret').start(feed);
    const socket = sockets[0]!;

    for (const event of RUN_EVENTS) socket.fire(event, serverToUiEventFixtures[event]);
    socket.fire('run.step', { v: 1, step: { ...stepFixture, seq: -1 } });
    socket.fire('run.finished', { v: 2, run: runFixture, note: null });

    expect(runs).toEqual(
      RUN_EVENTS.map((event) => ({ event, payload: serverToUiEventFixtures[event] })),
    );
  });

  it('loads the daemons on each connect, applies node.updated, and says it synced', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    nodesBody = [nodeSummaryFixture];
    const { feed, nodeLists, nodes, syncs } = recorder();
    serverSource('s3cret').start(feed);
    const socket = sockets[0]!;

    socket.fire('connect');
    expect(syncs()).toBe(1);
    await vi.waitFor(() => expect(nodeLists).toEqual([[nodeSummaryFixture]]));
    expect(fetchMock).toHaveBeenCalledWith('/nodes', {
      headers: { authorization: 'Bearer s3cret', accept: 'application/json' },
    });

    const gone = { ...nodeSummaryFixture, connected: false, current: [] };
    socket.fire('node.updated', { v: 1, node: gone });
    socket.fire('node.updated', { v: 1, node: { ...gone, name: 'not a name' } });
    expect(nodes).toEqual([gone]);

    socket.fire('disconnect', 'transport close');
    socket.fire('connect');
    expect(syncs()).toBe(2);
    await vi.waitFor(() => expect(nodeLists).toHaveLength(2));
  });

  it('applies a node.updated that lands while GET /nodes loads again after the list', async () => {
    let answer: (res: Response) => void = () => undefined;
    fetchMock.mockImplementation((url: string) =>
      url === '/nodes'
        ? new Promise<Response>((resolve) => (answer = resolve))
        : Promise.resolve(json([issueFixture])),
    );
    const { feed, calls } = recorder();
    serverSource('s3cret').start(feed);
    const socket = sockets[0]!;
    socket.fire('connect');

    const newer = { ...nodeSummaryFixture, current: [] };
    socket.fire('node.updated', { v: 1, node: newer });
    answer(json([nodeSummaryFixture]));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    // The list was read before the update, so the update goes on top of it again.
    expect(calls).toEqual([`node ${newer.name}`, 'resetNodes', `node ${newer.name}`]);
  });

  it('keeps going when GET /nodes fails or breaks the contract', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    nodesBody = [{ name: 'x' }];
    const { feed, nodeLists, lists } = recorder();
    serverSource('s3cret').start(feed);
    sockets[0]!.fire('connect');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(nodeLists).toEqual([]);
    await vi.waitFor(() => expect(lists).toHaveLength(1));
  });

  it("fetches a daemon's runs with the token, and finds nothing for a 404 or a bad body", async () => {
    const source = serverSource('s3cret');

    fetchMock.mockResolvedValueOnce(json([nodeRunFixture]));
    expect(await source.fetchNodeRuns('railway-node')).toEqual([nodeRunFixture]);
    expect(fetchMock).toHaveBeenLastCalledWith('/nodes/railway-node/runs', {
      headers: { authorization: 'Bearer s3cret', accept: 'application/json' },
    });

    fetchMock.mockResolvedValueOnce(json({ statusCode: 400 }, 400));
    expect(await source.fetchNodeRuns('railway-node')).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json([{ ...nodeRunFixture, stepCount: -1 }]));
    expect(await source.fetchNodeRuns('railway-node')).toBeUndefined();
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await source.fetchNodeRuns('railway-node')).toBeUndefined();
  });

  it('asks for a token when the socket or the list refuses this one', async () => {
    const { feed, statuses } = recorder();
    serverSource('wrong').start(feed);
    sockets[0]!.fire('connect_error', new Error('unauthorized'));
    expect(statuses.at(-1)).toBe('needs_token');

    fetchMock.mockResolvedValueOnce(json({ statusCode: 401 }, 401));
    sockets[0]!.fire('connect');
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('needs_token'));
  });

  it('waits out a rate limit, then connects again', () => {
    vi.useFakeTimers();
    const { feed, statuses } = recorder();
    const stop = serverSource('s3cret').start(feed);
    const socket = sockets[0]!;

    socket.fire('connect_error', new Error('rate_limited'));
    expect(statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(59_000);
    expect(socket.connects).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(socket.connects).toBe(1);

    socket.fire('connect_error', new Error('rate_limited'));
    stop();
    vi.advanceTimersByTime(60_000);
    expect(socket.connects).toBe(1);
    expect(socket.closed).toBe(true);
  });

  it('shows a dropped connection as reconnecting, and reloads the list when it is back', async () => {
    const { feed, statuses, lists } = recorder();
    serverSource('s3cret').start(feed);
    const socket = sockets[0]!;

    socket.fire('connect_error', new Error('xhr poll error'));
    expect(statuses.at(-1)).toBe('reconnecting');
    socket.fire('connect');
    socket.fire('disconnect', 'transport close');
    expect(statuses.at(-1)).toBe('reconnecting');
    socket.fire('connect');

    await vi.waitFor(() => expect(lists).toHaveLength(2));
  });

  it('keeps going when the list fails or breaks the contract', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { feed, statuses, lists } = recorder();
    serverSource('s3cret').start(feed);

    fetchMock.mockResolvedValueOnce(json([{ id: 'nope' }]));
    sockets[0]!.fire('connect');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    sockets[0]!.fire('connect');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));

    expect(lists).toEqual([]);
    expect(statuses.at(-1)).toBe('live');
  });

  it('fetches one issue, and finds nothing for a 404, a bad body or a network error', async () => {
    const source = serverSource('s3cret');

    fetchMock.mockResolvedValueOnce(json(issueFixture));
    expect(await source.fetchIssue(issueFixture.id)).toEqual(issueFixture);
    expect(fetchMock).toHaveBeenLastCalledWith(`/issues/${issueFixture.id}`, expect.anything());

    fetchMock.mockResolvedValueOnce(json({ statusCode: 404 }, 404));
    expect(await source.fetchIssue(issueFixture.id)).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json({ id: 'nope' }));
    expect(await source.fetchIssue(issueFixture.id)).toBeUndefined();
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await source.fetchIssue(issueFixture.id)).toBeUndefined();
  });

  it("fetches an issue's runs with the token, and finds nothing for a 404 or a bad body", async () => {
    const source = serverSource('s3cret');
    const run = {
      id: '10000000-2222-4222-8222-222222222222',
      issueId: issueFixture.id,
      tier: 1,
      status: 'running',
      startedAt: '2026-11-22T09:00:00.000Z',
      finishedAt: null,
      prUrl: null,
      confidence: null,
      diff: null,
      steps: [],
    };

    fetchMock.mockResolvedValueOnce(json([run]));
    expect(await source.fetchRuns(issueFixture.id)).toEqual([run]);
    expect(fetchMock).toHaveBeenLastCalledWith(`/issues/${issueFixture.id}/runs`, {
      headers: { authorization: 'Bearer s3cret', accept: 'application/json' },
    });

    fetchMock.mockResolvedValueOnce(json({ statusCode: 404 }, 404));
    expect(await source.fetchRuns(issueFixture.id)).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json([{ ...run, status: 'nope' }]));
    expect(await source.fetchRuns(issueFixture.id)).toBeUndefined();
  });

  it('posts a review event with the token, and turns a refusal into its message', async () => {
    const source = serverSource('s3cret');
    const resolved = { ...issueFixture, status: 'resolved' };

    fetchMock.mockResolvedValueOnce(json(resolved));
    expect(await source.applyEvent(issueFixture.id, { type: 'approve' })).toEqual(resolved);
    expect(fetchMock).toHaveBeenLastCalledWith(`/issues/${issueFixture.id}/events`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer s3cret',
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'approve' }),
    });

    fetchMock.mockResolvedValueOnce(
      json({ statusCode: 409, message: 'cannot approve an issue that is fixing' }, 409),
    );
    await expect(source.applyEvent(issueFixture.id, { type: 'approve' })).rejects.toThrow(
      'cannot approve an issue that is fixing',
    );
    fetchMock.mockResolvedValueOnce(json({ statusCode: 401 }, 401));
    await expect(
      source.applyEvent(issueFixture.id, { type: 'reject', reason: 'no' }),
    ).rejects.toThrow('The orchestrator refused the token.');
  });
});

describe('serverPresent', () => {
  it('is true only when /health answers JSON', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'ok' }));
    expect(await serverPresent()).toBe(true);
    fetchMock.mockResolvedValueOnce(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
    );
    expect(await serverPresent()).toBe(false);
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await serverPresent()).toBe(false);
  });
});
