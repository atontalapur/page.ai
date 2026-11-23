import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueSchema, type Issue } from '@page/contracts';

import { mockId, mockSource } from './mock-source';
import type { FeedStatus, IssueFeed } from './source';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function recorder() {
  const statuses: FeedStatus[] = [];
  const lists: Issue[][] = [];
  const updates: Issue[] = [];
  const feed: IssueFeed = {
    status: (status) => statuses.push(status),
    reset: (issues) => lists.push(issues),
    update: (issue) => updates.push(issue),
  };
  return { feed, statuses, lists, updates };
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

  it('makes distinct uuids that read apart on screen', () => {
    const ids = [1, 2, 3].map(mockId);
    expect(new Set(ids.map((id) => id.slice(0, 8))).size).toBe(3);
    for (const id of ids) expect(issueSchema.shape.id.safeParse(id).success).toBe(true);
  });
});
