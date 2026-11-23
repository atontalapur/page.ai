import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  issueRunSchema,
  issueSchema,
  nodeRunSchema,
  nodeSummarySchema,
  serverToUiEvents,
  type Issue,
  type NodeSummary,
} from '@page/contracts';

import { MOCK_NODES } from './mock-nodes';
import { mockId, mockSource } from './mock-source';
import { runIdOf, type FeedStatus, type IssueFeed, type RunEvent } from './source';

afterEach(() => {
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
  const feed: IssueFeed = {
    status: (status) => statuses.push(status),
    reset: (issues) => lists.push(issues),
    update: (issue) => updates.push(issue),
    synced: () => undefined,
    run: (event) => runs.push(event),
    resetNodes: (list) => nodeLists.push(list),
    node: (node) => nodes.push(node),
  };
  return { feed, statuses, lists, updates, runs, nodeLists, nodes };
}

describe('mockSource', () => {
  it('starts as mock with seeded issues that meet the contract', () => {
    const { feed, statuses, lists } = recorder();
    mockSource({ intervalMs: 0 }).start(feed);

    expect(statuses).toEqual(['mock']);
    expect(lists[0]!.length).toBeGreaterThan(0);
    for (const issue of lists[0]!) expect(issueSchema.parse(issue)).toEqual(issue);
  });

  it('plays an arrival, a triage, a repeat and a fix, each a valid issue.updated', () => {
    const { feed, updates } = recorder();
    const source = mockSource({ intervalMs: 0 });
    source.start(feed);

    for (let i = 0; i < 8; i++) source.tick();

    expect(updates).toHaveLength(8);
    for (const issue of updates) expect(issueSchema.parse(issue)).toEqual(issue);
    const [arrived, triaged, repeated, advanced] = updates;
    expect(arrived).toMatchObject({ status: 'new', occurrences: 1, class: null });
    expect(triaged).toMatchObject({ id: arrived!.id, status: 'triaged' });
    expect(triaged!.severity).not.toBeNull();
    expect(repeated!.occurrences).toBeGreaterThan(1);
    expect(advanced).toMatchObject({ status: 'fixing', currentTier: 1 });
  });

  it('escalates a fix, sends it for approval, and resolves it', () => {
    const { feed, updates } = recorder();
    const source = mockSource({ intervalMs: 0 });
    source.start(feed);

    for (let i = 0; i < 40; i++) source.tick();

    expect(updates.some((u) => u.status === 'fixing' && u.currentTier === 2)).toBe(true);
    expect(updates.some((u) => u.status === 'awaiting_approval')).toBe(true);
    expect(updates.some((u) => u.status === 'resolved')).toBe(true);
  });

  it('plays on its own every interval, and stops', () => {
    vi.useFakeTimers();
    const { feed, updates } = recorder();
    const stop = mockSource({ intervalMs: 1_000 }).start(feed);

    vi.advanceTimersByTime(3_000);
    expect(updates).toHaveLength(3);
    stop();
    vi.advanceTimersByTime(3_000);
    expect(updates).toHaveLength(3);
  });

  it('drops a pushed payload that breaks the contract', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { feed, updates } = recorder();
    const source = mockSource({ intervalMs: 0 });
    source.start(feed);

    source.push({ v: 1, issue: { id: 'nope' } });
    expect(updates).toEqual([]);
  });

  it('finds its issues by id', async () => {
    const { feed, lists } = recorder();
    const source = mockSource({ intervalMs: 0 });
    source.start(feed);
    const first = lists[0]![0]!;

    expect(await source.fetchIssue(first.id)).toEqual(first);
    expect(await source.fetchIssue('missing')).toBeUndefined();
  });

  it('starts with three daemons, one on the seeded fix, that meet the contract', async () => {
    const { feed, nodeLists, lists } = recorder();
    const source = mockSource({ intervalMs: 0 });
    source.start(feed);

    const [nodes] = nodeLists;
    expect(nodes!.map((n) => n.name)).toEqual([...MOCK_NODES]);
    for (const node of nodes!) expect(nodeSummarySchema.parse(node)).toEqual(node);
    const fixing = lists[0]!.find((i) => i.status === 'fixing')!;
    expect(nodes![0]).toMatchObject({ connected: true, current: [{ issueId: fixing.id }] });
    expect(nodes![2]).toMatchObject({ connected: false, current: [] });
    expect(nodes![2]!.lastRunAt).not.toBeNull();

    // The seeded issues have their runs, and each daemon its history.
    const awaiting = lists[0]!.find((i) => i.status === 'awaiting_approval')!;
    const runs = await source.fetchRuns(awaiting.id);
    expect(runs!.map((r) => [r.tier, r.status])).toEqual([
      [1, 'escalated'],
      [2, 'succeeded'],
    ]);
    for (const run of runs!) expect(issueRunSchema.parse(run)).toEqual(run);
    expect(runs![1]!.diff).toContain('+++ b/');
    const history = await source.fetchNodeRuns(MOCK_NODES[2]);
    expect(history!.length).toBe(2);
    for (const run of history!) expect(nodeRunSchema.parse(run)).toEqual(run);
  });

  it('runs each fix on a daemon: started, a step per tick, escalated, then succeeded', () => {
    const { feed, updates, runs, nodes } = recorder();
    // A second a call, so the script picks the oldest fix the same way every run.
    let t = Date.parse('2026-11-22T09:00:00.000Z');
    const source = mockSource({ intervalMs: 0, now: () => new Date((t += 1_000)) });
    source.start(feed);

    for (let i = 0; i < 21; i++) source.tick();

    // Each event went out through its contract.
    for (const { event, payload } of runs) {
      expect(serverToUiEvents[event].safeParse(payload).success).toBe(true);
    }
    const started = updates.find((u) => u.status === 'fixing' && u.currentTier === 1)!;
    const ofIssue = (issueId: string) =>
      runs.filter(
        (r) =>
          (r.event === 'run.started' || r.event === 'run.finished') &&
          r.payload.run.issueId === issueId,
      );
    expect(
      ofIssue(started.id).map((r) => [r.event, 'run' in r.payload && r.payload.run.status]),
    ).toEqual([
      ['run.started', 'running'],
      ['run.finished', 'escalated'],
      ['run.started', 'running'],
      ['run.finished', 'succeeded'],
    ]);
    const [tier1] = ofIssue(started.id);
    const steps = runs.filter((r) => r.event === 'run.step' && runIdOf(r) === runIdOf(tier1!));
    expect(steps.length).toBeGreaterThan(1);
    expect(runs.some((r) => r.event === 'run.diff')).toBe(true);
    // A daemon took each run and let it go.
    expect(nodes.some((n) => n.current.some((r) => r.issueId === started.id))).toBe(true);
    expect(nodes.at(-1)!.current.some((r) => r.issueId === started.id)).toBe(false);
  });

  it('drops a daemon now and then, and brings it back', () => {
    const { feed, nodes } = recorder();
    const source = mockSource({ intervalMs: 0 });
    source.start(feed);

    for (let i = 0; i < 40; i++) source.tick();
    const flaky = nodes.filter((n) => n.name === MOCK_NODES[1]);
    expect(flaky.some((n) => !n.connected)).toBe(true);
    expect(flaky.some((n) => n.connected)).toBe(true);
  });

  it('starts a fix on a triaged issue, and leaves reviews to the orchestrator', async () => {
    const { feed, lists, runs } = recorder();
    const source = mockSource({ intervalMs: 0 });
    source.start(feed);
    const triaged = lists[0]!.find((i) => i.status === 'triaged')!;

    const started = await source.applyEvent(triaged.id, { type: 'start_fix' });
    expect(started).toMatchObject({ status: 'fixing', currentTier: 1 });
    expect(
      runs.some((r) => r.event === 'run.started' && r.payload.run.issueId === triaged.id),
    ).toBe(true);
    await expect(source.applyEvent(triaged.id, { type: 'start_fix' })).rejects.toThrow(
      'Only a triaged incident can start a fix.',
    );
    await expect(source.applyEvent(triaged.id, { type: 'approve' })).rejects.toThrow(
      'Mock data has no orchestrator to review with.',
    );
  });

  it('makes distinct uuids that read apart on screen', () => {
    const ids = [1, 2, 3].map(mockId);
    expect(new Set(ids.map((id) => id.slice(0, 8))).size).toBe(3);
    for (const id of ids) expect(issueSchema.shape.id.safeParse(id).success).toBe(true);
  });
});
