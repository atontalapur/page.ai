import { useCallback, useEffect, useRef, useState } from 'react';
import type { IssueRun, NodeRun } from '@page/contracts';

import { useAgents, useIssues, useRunFeed } from '../context/IssuesContext';
import { applyToIssueRuns, applyToNodeRuns } from './runs';
import type { RunEvent } from './source';

export interface LiveRuns<R> {
  /** Undefined until the first load returns. */
  runs: R[] | undefined;
  /** The last load failed; `runs` keeps what an earlier one returned. */
  failed: boolean;
}

/**
 * The runs `load` returns, kept current: each run event is applied as it arrives, and the
 * list is loaded again after every reconnect (the socket misses what is sent while it is
 * down) and whenever `key` changes. The events that land while a load is in flight are
 * applied again on top of what it returns, since it may have read the database before them.
 */
function useLiveList<R>(
  load: () => Promise<R[] | undefined>,
  key: string,
  apply: (runs: R[], event: RunEvent) => R[],
): LiveRuns<R> {
  const { syncs, subscribeRuns } = useRunFeed();
  // Runs are kept with the load they came from, so a new subject never shows the last one's.
  const [state, setState] = useState<{ from: typeof load; runs: R[] } | undefined>();
  const [failed, setFailed] = useState(false);
  const inFlight = useRef<RunEvent[] | undefined>(undefined);

  useEffect(
    () =>
      subscribeRuns((event) => {
        inFlight.current?.push(event);
        setState((current) => current && { ...current, runs: apply(current.runs, event) });
      }),
    [subscribeRuns, apply],
  );

  useEffect(() => {
    let cancelled = false;
    const during: RunEvent[] = [];
    inFlight.current = during;
    void load().then((loaded) => {
      if (cancelled) return;
      if (inFlight.current === during) inFlight.current = undefined;
      if (loaded) setState({ from: load, runs: during.reduce(apply, loaded) });
      setFailed(loaded === undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [load, key, syncs, apply]);

  return { runs: state?.from === load ? state.runs : undefined, failed };
}

/**
 * An issue's runs with their steps, oldest first, kept current. `key` is what else should
 * load them again, such as the issue's `updatedAt`: a run's result reaches the database after
 * its `run.finished`, and the issue changes once it is recorded.
 */
export function useIssueRuns(issueId: string, key = ''): LiveRuns<IssueRun> {
  const { fetchRuns } = useIssues();
  const load = useCallback(() => fetchRuns(issueId), [fetchRuns, issueId]);
  const apply = useCallback(
    (runs: IssueRun[], event: RunEvent) => applyToIssueRuns(runs, event, issueId),
    [issueId],
  );
  return useLiveList(load, key, apply);
}

/** The runs a daemon worked, newest first, kept current like an issue's. */
export function useNodeRuns(name: string, key = ''): LiveRuns<NodeRun> {
  const { fetchNodeRuns } = useAgents();
  const load = useCallback(() => fetchNodeRuns(name), [fetchNodeRuns, name]);
  return useLiveList(load, key, applyToNodeRuns);
}
