import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  decidedApprovalFixture,
  issueFixture,
  nodeRunFixture,
  nodeSummaryFixture,
  pendingApprovalFixture,
  runFixture,
  serverToUiEventFixtures,
  stepFixture,
} from '@page/contracts/fixtures';
import type { Approval, Issue, NodeSummary } from '@page/contracts';

import { RUN_EVENTS, type FeedStatus, type IssueFeed, type RunEvent } from './source';

type Handler = (arg?: unknown) => void;

/** Plays the socket.io-client socket the source opens. */
class FakeSocket {
  handlers = new Map<string, Handler>();
  connects = 0;
  disconnects = 0;
  closed = false;
  auth: unknown;
  emitted: [string, unknown][] = [];
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  fire(event: string, arg?: unknown) {
    this.handlers.get(event)?.(arg);
  }
  emit(event: string, payload: unknown) {
    this.emitted.push([event, payload]);
    return this;
  }
  connect() {
    this.connects += 1;
    return this;
  }
  disconnect() {
    this.disconnects += 1;
    return this;
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
  const approvals: Approval[] = [];
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
    approval: (approval) => approvals.push(approval),
  };
  return {
    feed,
    statuses,
    lists,
    updates,
    runs,
    nodeLists,
    nodes,
    calls,
    syncs: () => syncs,
    approvals,
  };
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

  it('reports nothing for the disconnect its own stop causes', () => {
    const { feed, statuses } = recorder();
    const stop = serverSource('s3cret').start(feed);
    const socket = sockets[0]!;
    socket.fire('connect');
    stop();
    // socket.io-client fires disconnect when a connected socket is closed.
    socket.fire('disconnect', 'io client disconnect');
    expect(socket.closed).toBe(true);
    expect(statuses.at(-1)).toBe('live');
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

describe('serverSource approvals', () => {
  it('sends the name in the handshake, and passes on approvals that meet the contract', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { feed, approvals } = recorder();
    serverSource('s3cret', 'Arjun').start(feed);
    expect(io).toHaveBeenCalledWith('/ui', { auth: { token: 's3cret', name: 'Arjun' } });
    const socket = sockets[0]!;

    socket.fire('approval.requested', { v: 1, approval: pendingApprovalFixture });
    socket.fire('approval.updated', { v: 1, approval: decidedApprovalFixture });
    socket.fire('approval.updated', { v: 1, approval: pendingApprovalFixture });
    socket.fire('approval.requested', { v: 2, approval: pendingApprovalFixture });

    expect(approvals).toEqual([pendingApprovalFixture, decidedApprovalFixture]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('sends a decision on the socket, and none while it is stopped', () => {
    const source = serverSource('s3cret', 'Arjun');
    source.decideApproval(pendingApprovalFixture.id, 'approved');
    const stop = source.start(recorder().feed);
    source.decideApproval(pendingApprovalFixture.id, 'rejected');
    stop();
    source.decideApproval(pendingApprovalFixture.id, 'approved');

    expect(sockets[0]!.emitted).toEqual([
      ['approval.decide', { v: 1, approvalId: pendingApprovalFixture.id, decision: 'rejected' }],
    ]);
  });

  it('connects again under a new name, since the name goes in the handshake', () => {
    const later = serverSource('s3cret');
    later.setApproverName?.('Nidheesh');
    later.start(recorder().feed);
    expect(io).toHaveBeenLastCalledWith('/ui', { auth: { token: 's3cret', name: 'Nidheesh' } });

    const source = serverSource('s3cret');
    source.start(recorder().feed);
    const socket = sockets[1]!;
    source.setApproverName?.('Daniyal');
    expect(socket.auth).toEqual({ token: 's3cret', name: 'Daniyal' });
    expect([socket.disconnects, socket.connects]).toEqual([1, 1]);
  });

  it("fetches an issue's approvals, and finds nothing for a 404, a bad body or a network error", async () => {
    const source = serverSource('s3cret');

    fetchMock.mockResolvedValueOnce(json([pendingApprovalFixture, decidedApprovalFixture]));
    expect(await source.fetchApprovals(issueFixture.id)).toEqual([
      pendingApprovalFixture,
      decidedApprovalFixture,
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(`/approvals?issueId=${issueFixture.id}`, {
      headers: { authorization: 'Bearer s3cret', accept: 'application/json' },
    });

    fetchMock.mockResolvedValueOnce(json({ statusCode: 404 }, 404));
    expect(await source.fetchApprovals(issueFixture.id)).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json([{ id: 'nope' }]));
    expect(await source.fetchApprovals(issueFixture.id)).toBeUndefined();
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await source.fetchApprovals(issueFixture.id)).toBeUndefined();
  });

  it('asks who the token names, and finds nothing for an older server, a bad body or no network', async () => {
    const source = serverSource('personal-token');

    fetchMock.mockResolvedValueOnce(json({ token: 'personal', name: 'Arjun' }));
    expect(await source.fetchSession!()).toEqual({ token: 'personal', name: 'Arjun' });
    expect(fetchMock).toHaveBeenLastCalledWith('/me', {
      headers: { authorization: 'Bearer personal-token', accept: 'application/json' },
    });
    fetchMock.mockResolvedValueOnce(json({ token: 'shared', canDecide: false }));
    expect(await source.fetchSession!()).toEqual({ token: 'shared', canDecide: false });

    fetchMock.mockResolvedValueOnce(json({ statusCode: 404 }, 404));
    expect(await source.fetchSession!()).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json({ token: 'personal', name: 'ui:Arjun' }));
    expect(await source.fetchSession!()).toBeUndefined();
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await source.fetchSession!()).toBeUndefined();
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
