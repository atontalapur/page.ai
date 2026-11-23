// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { IssueRun } from '@page/contracts';
import { nodeRunFixture, runFixture, stepFixture } from '@page/contracts/fixtures';

import { IssuesProvider } from '../context/IssuesContext';
import { testSource, type TestSource } from '../test-utils';
import { useIssueRuns, useNodeRuns } from './useLiveRuns';

afterEach(() => {
  cleanup();
});

const issueRun: IssueRun = { ...runFixture, diff: null, steps: [stepFixture], chats: [] };

function wrapper(source: TestSource) {
  return ({ children }: { children: ReactNode }) => (
    <IssuesProvider source={source}>{children}</IssuesProvider>
  );
}

describe('useIssueRuns', () => {
  it('applies a step that lands while the runs load again, on top of what the load read', async () => {
    const source = testSource([]);
    source.runs.set(runFixture.issueId, [issueRun]);
    const { result } = renderHook(() => useIssueRuns(runFixture.issueId), {
      wrapper: wrapper(source),
    });
    await waitFor(() => expect(result.current.runs).toEqual([issueRun]));

    // The next load answers late, with what the database held before step 1.
    let answer: (runs: IssueRun[]) => void = () => undefined;
    source.fetchRuns = () => new Promise((resolve) => (answer = resolve));
    source.reconnect();
    source.sendRun('run.step', { v: 1, step: { ...stepFixture, seq: 1 } });
    answer([issueRun]);

    await waitFor(() => expect(result.current.runs?.[0]?.steps.map((s) => s.seq)).toEqual([0, 1]));
  });

  it('keeps the runs it had when a load fails, and says so', async () => {
    const source = testSource([]);
    source.runs.set(runFixture.issueId, [issueRun]);
    const { result } = renderHook(() => useIssueRuns(runFixture.issueId), {
      wrapper: wrapper(source),
    });
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    source.fetchRuns = () => Promise.resolve(undefined);
    source.reconnect();
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.runs).toHaveLength(1);
  });
});

describe('useNodeRuns', () => {
  it("loads a daemon's runs, applies its steps, and loads them again on a new key", async () => {
    const source = testSource([]);
    source.nodeRuns.set('railway-node', [nodeRunFixture]);
    const { result, rerender } = renderHook(({ key }) => useNodeRuns('railway-node', key), {
      wrapper: wrapper(source),
      initialProps: { key: 'a' },
    });
    await waitFor(() => expect(result.current.runs).toEqual([nodeRunFixture]));

    source.sendRun('run.step', { v: 1, step: { ...stepFixture, seq: 6 } });
    expect(result.current.runs?.[0]).toMatchObject({ stepCount: 7, lastStep: { seq: 6 } });

    const loads = source.loads.nodeRuns;
    rerender({ key: 'b' });
    await waitFor(() => expect(source.loads.nodeRuns).toBe(loads + 1));
  });
});
