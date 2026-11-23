import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Issue, IssueEvent, IssueEventRecord, IssueRun } from '@page/contracts';

import { mockSource } from '../live/mock-source';
import { serverPresent, serverSource } from '../live/server-source';
import type { FeedStatus, IssueFeed, IssueSource } from '../live/source';
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

/** Keeps `incoming` unless the store already has a newer copy of the issue. */
function upsert(store: Map<string, Issue>, incoming: Issue): void {
  const current = store.get(incoming.id);
  if (!current || current.updatedAt <= incoming.updatedAt) store.set(incoming.id, incoming);
}

/**
 * The issues every page reads, kept current by a source: the orchestrator that served the
 * page (GET /issues, then `issue.updated` on the socket), or the mock source when there is
 * none. Tests pass a source directly.
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
    };
    return active.start(feed);
  }, [active]);

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

  return <IssuesContext.Provider value={value}>{children}</IssuesContext.Provider>;
}

export function useIssues(): IssuesContextType {
  const context = useContext(IssuesContext);

  if (!context) {
    throw new Error('useIssues must be used inside IssuesProvider');
  }

  return context;
}

/** The provider's status, or undefined outside one (the layout renders in tests without it). */
export function useIssuesStatus(): IssuesStatus | undefined {
  return useContext(IssuesContext)?.status;
}
