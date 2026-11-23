import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Issue,
  IssueEvent,
  IssueEventRecord,
  IssueRun,
  NodeRun,
  NodeSummary,
} from '@page/contracts';

import { mockSource } from '../live/mock-source';
import { applyToNode } from '../live/runs';
import { serverPresent, serverSource } from '../live/server-source';
import type { FeedStatus, IssueFeed, IssueSource, RunEvent } from '../live/source';
import { clearToken, readToken, saveToken } from '../live/token';

/** `detecting` until the page knows whether an orchestrator served it. */
export type IssuesStatus = FeedStatus | 'detecting';

interface IssuesContextType {
  /** Most recently updated first, as GET /issues orders them. */
  issues: Issue[];
  status: IssuesStatus;
  /** The first full list has arrived. */
  loaded: boolean;
  /** The last token sent was refused. */
  tokenRefused: boolean;
  getIssue: (id: string) => Issue | undefined;
  fetchIssue: (id: string) => Promise<Issue | undefined>;
  fetchRuns: (id: string) => Promise<IssueRun[] | undefined>;
  fetchEvents: (id: string) => Promise<IssueEventRecord[] | undefined>;
  /** Applies a reviewer's event and stores the issue it left. Rejects with the reason it failed. */
  applyEvent: (id: string, event: IssueEvent) => Promise<Issue>;
  submitToken: (token: string) => void;
}

const IssuesContext = createContext<IssuesContextType | undefined>(undefined);

interface AgentsContextType {
  /** Every node daemon the source knows, by name. */
  nodes: NodeSummary[];
  /** The first full list has arrived. */
  loaded: boolean;
  getNode: (name: string) => NodeSummary | undefined;
  fetchNodeRuns: (name: string) => Promise<NodeRun[] | undefined>;
}

const AgentsContext = createContext<AgentsContextType | undefined>(undefined);

type RunListener = (event: RunEvent) => void;

interface RunFeedContextType {
  /**
   * How many times the source has (re)connected. A run loaded before the latest may have
   * missed steps sent while the socket was down, so whatever holds one loads it again.
   */
  syncs: number;
  /** Calls `listener` with every run event from now on, and returns the function that stops. */
  subscribeRuns: (listener: RunListener) => () => void;
}

const RunFeedContext = createContext<RunFeedContextType | undefined>(undefined);

/** Keeps `incoming` unless the store already has a newer copy of the issue. */
function upsert(store: Map<string, Issue>, incoming: Issue): void {
  const current = store.get(incoming.id);
  if (!current || current.updatedAt <= incoming.updatedAt) store.set(incoming.id, incoming);
}

/**
 * The issues and node daemons every page reads, kept current by a source: the orchestrator
 * that served the page (GET /issues and GET /nodes, then `issue.updated`, `node.updated` and
 * the run events on the socket), or the mock source when there is none. Run events are also
 * passed to whatever subscribed, such as a page showing a run's steps. Tests pass a source
 * directly.
 */
export function IssuesProvider({
  children,
  source,
}: {
  children: ReactNode;
  source?: IssueSource;
}) {
  const [active, setActive] = useState<IssueSource | undefined>(source);
  const [status, setStatus] = useState<IssuesStatus>(source ? 'connecting' : 'detecting');
  const [store, setStore] = useState<Map<string, Issue>>(() => new Map());
  const [loaded, setLoaded] = useState(false);
  const [tokenRefused, setTokenRefused] = useState(false);
  const [nodeStore, setNodeStore] = useState<Map<string, NodeSummary>>(() => new Map());
  const [nodesLoaded, setNodesLoaded] = useState(false);
  const [syncs, setSyncs] = useState(0);
  const runListeners = useRef(new Set<RunListener>());

  // Pick a source once, unless one was passed in.
  useEffect(() => {
    if (source) return;
    let cancelled = false;
    void serverPresent().then((present) => {
      if (cancelled) return;
      if (!present) return setActive(mockSource());
      const token = readToken();
      if (token) setActive(serverSource(token));
      else setStatus('needs_token');
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (!active) return;
    const feed: IssueFeed = {
      reset(issues) {
        setStore((previous) => {
          const next = new Map(previous);
          for (const issue of issues) upsert(next, issue);
          return next;
        });
        setLoaded(true);
      },
      update(issue) {
        setStore((previous) => {
          const next = new Map(previous);
          upsert(next, issue);
          return next;
        });
      },
      status(next) {
        setStatus(next);
        if (next === 'needs_token') {
          clearToken();
          setTokenRefused(true);
          setActive(undefined);
        }
      },
      synced() {
        setSyncs((n) => n + 1);
      },
      run(event) {
        setNodeStore((previous) => {
          let changed = false;
          const next = new Map<string, NodeSummary>();
          for (const [name, node] of previous) {
            const after = applyToNode(node, event);
            changed ||= after !== node;
            next.set(name, after);
          }
          return changed ? next : previous;
        });
        for (const listener of runListeners.current) listener(event);
      },
      resetNodes(nodes) {
        setNodeStore(new Map(nodes.map((node) => [node.name, node])));
        setNodesLoaded(true);
      },
      node(node) {
        setNodeStore((previous) => new Map(previous).set(node.name, node));
      },
    };
    return active.start(feed);
  }, [active]);

  const subscribeRuns = useCallback((listener: RunListener) => {
    runListeners.current.add(listener);
    return () => {
      runListeners.current.delete(listener);
    };
  }, []);

  const submitToken = useCallback((token: string) => {
    saveToken(token);
    setTokenRefused(false);
    setActive(serverSource(token));
  }, []);

  const issues = useMemo(
    () => [...store.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [store],
  );
  const getIssue = useCallback((id: string) => store.get(id), [store]);

  const fetchIssue = useCallback(
    async (id: string) => {
      const issue = await active?.fetchIssue(id);
      if (issue) {
        setStore((previous) => {
          const next = new Map(previous);
          upsert(next, issue);
          return next;
        });
      }
      return issue;
    },
    [active],
  );

  const fetchRuns = useCallback(
    (id: string) => active?.fetchRuns(id) ?? Promise.resolve(undefined),
    [active],
  );

  const fetchEvents = useCallback(
    (id: string) => active?.fetchEvents(id) ?? Promise.resolve(undefined),
    [active],
  );

  const fetchNodeRuns = useCallback(
    (name: string) => active?.fetchNodeRuns(name) ?? Promise.resolve(undefined),
    [active],
  );

  const applyEvent = useCallback(
    async (id: string, event: IssueEvent) => {
      if (!active) throw new Error('Not connected to the orchestrator.');
      const issue = await active.applyEvent(id, event);
      setStore((previous) => {
        const next = new Map(previous);
        upsert(next, issue);
        return next;
      });
      return issue;
    },
    [active],
  );

  const value = useMemo(
    () => ({
      issues,
      status,
      loaded,
      tokenRefused,
      getIssue,
      fetchIssue,
      fetchRuns,
      fetchEvents,
      applyEvent,
      submitToken,
    }),
    [
      issues,
      status,
      loaded,
      tokenRefused,
      getIssue,
      fetchIssue,
      fetchRuns,
      fetchEvents,
      applyEvent,
      submitToken,
    ],
  );

  const nodes = useMemo(
    () => [...nodeStore.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [nodeStore],
  );
  const getNode = useCallback((name: string) => nodeStore.get(name), [nodeStore]);
  const agents = useMemo(
    () => ({ nodes, loaded: nodesLoaded, getNode, fetchNodeRuns }),
    [nodes, nodesLoaded, getNode, fetchNodeRuns],
  );
  const runFeed = useMemo(() => ({ syncs, subscribeRuns }), [syncs, subscribeRuns]);

  return (
    <IssuesContext.Provider value={value}>
      <AgentsContext.Provider value={agents}>
        <RunFeedContext.Provider value={runFeed}>{children}</RunFeedContext.Provider>
      </AgentsContext.Provider>
    </IssuesContext.Provider>
  );
}

export function useIssues(): IssuesContextType {
  const context = useContext(IssuesContext);

  if (!context) {
    throw new Error('useIssues must be used inside IssuesProvider');
  }

  return context;
}

/** The node daemons, kept current like the issues. */
export function useAgents(): AgentsContextType {
  const context = useContext(AgentsContext);
  if (!context) throw new Error('useAgents must be used inside IssuesProvider');
  return context;
}

/** The run events and the reconnect count, for hooks that keep a run's steps current. */
export function useRunFeed(): RunFeedContextType {
  const context = useContext(RunFeedContext);
  if (!context) throw new Error('useRunFeed must be used inside IssuesProvider');
  return context;
}

/** The provider's status, or undefined outside one (the layout renders in tests without it). */
export function useIssuesStatus(): IssuesStatus | undefined {
  return useContext(IssuesContext)?.status;
}
