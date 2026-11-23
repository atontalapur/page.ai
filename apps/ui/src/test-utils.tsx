import type { ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type {
  Issue,
  IssueEvent,
  IssueEventRecord,
  IssueRun,
  NodeRun,
  NodeSummary,
} from '@page/contracts';
import { issueFixture } from '@page/contracts/fixtures';

import { IssuesProvider } from './context/IssuesContext';
import {
  parseIssueUpdated,
  parseNodeUpdated,
  parseRunEvent,
  type FeedStatus,
  type IssueFeed,
  type IssueSource,
  type RunEventName,
} from './live/source';

/** An issue like the contracts fixture, with its own id and the given fields. */
export function issue(n: number, fields: Partial<Issue> = {}): Issue {
  const at = new Date(Date.UTC(2026, 10, 22, 9, n)).toISOString();
  return {
    ...issueFixture,
    id: `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    fingerprint: `fp-${n}`,
    title: `Error number ${n}`,
    createdAt: at,
    updatedAt: at,
    ...fields,
  };
}

/** A run as the agents page lists it, on `issueOf`, with its own id and the given fields. */
export function nodeRun(n: number, issueOf: Issue, fields: Partial<NodeRun> = {}): NodeRun {
  return {
    id: `${n.toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`,
    issueId: issueOf.id,
    issueTitle: issueOf.title,
    tier: 1,
    status: 'running',
    startedAt: '2026-11-22T09:00:00.000Z',
    finishedAt: null,
    prUrl: null,
    confidence: null,
    stepCount: 0,
    lastStep: null,
    ...fields,
  };
}

/** A node daemon called `name`: connected and idle unless the fields say otherwise. */
export function daemon(name: string, fields: Partial<NodeSummary> = {}): NodeSummary {
  return {
    name,
    connected: true,
    since: '2026-11-22T08:00:00.000Z',
    current: [],
    lastRunAt: null,
    ...fields,
  };
}

export interface TestSource extends IssueSource {
  /** Delivers a raw `issue.updated` payload the way the socket does: parsed first. */
  send(payload: unknown): void;
  /** Delivers a raw run event payload, parsed first. */
  sendRun(event: RunEventName, payload: unknown): void;
  /** Delivers a raw `node.updated` payload, parsed first. */
  sendNode(payload: unknown): void;
  /** Drops the socket and connects it again, as the server source reports that. */
  reconnect(): void;
  setStatus(status: FeedStatus): void;
  /** The daemons GET /nodes returns, at the start and after each reconnect. */
  nodes: NodeSummary[];
  /** What fetchNodeRuns returns per daemon; one missing here has none. */
  nodeRuns: Map<string, NodeRun[]>;
  /** How many times each kind of list was loaded: issue runs and daemon runs. */
  loads: { runs: number; nodeRuns: number };
  /** What fetchIssue finds beyond the list. */
  extra: Map<string, Issue>;
  /** What fetchRuns returns per issue; an issue missing here has no runs. */
  runs: Map<string, IssueRun[]>;
  /** What fetchEvents returns per issue; an issue missing here has none. */
  events: Map<string, IssueEventRecord[]>;
  /** Every event applyEvent was given, in order. */
  applied: { id: string; event: IssueEvent }[];
  /** What applyEvent answers; by default the issue with `status` set as the server would. */
  respond?: (id: string, event: IssueEvent) => Promise<Issue>;
}

/** A source that loads `issues` as its list and plays whatever a test sends. */
export function testSource(
  issues: Issue[],
  status: FeedStatus = 'live',
  nodes: NodeSummary[] = [],
): TestSource {
  let feed: IssueFeed | undefined;
  const extra = new Map<string, Issue>();
  const runs = new Map<string, IssueRun[]>();
  const events = new Map<string, IssueEventRecord[]>();
  const nodeRuns = new Map<string, NodeRun[]>();
  const applied: { id: string; event: IssueEvent }[] = [];
  const loads = { runs: 0, nodeRuns: 0 };
  const source: TestSource = {
    extra,
    runs,
    events,
    nodes,
    nodeRuns,
    loads,
    applied,
    start(next) {
      feed = next;
      feed.status(status);
      // A refused token stops the source before any list arrives.
      if (status !== 'needs_token') {
        feed.synced();
        feed.reset(issues);
        feed.resetNodes(source.nodes);
      }
      return () => {
        feed = undefined;
      };
    },
    fetchIssue: (id) => Promise.resolve(extra.get(id)),
    fetchRuns: (id) => {
      loads.runs += 1;
      return Promise.resolve(runs.get(id) ?? []);
    },
    fetchEvents: (id) => Promise.resolve(events.get(id) ?? []),
    fetchNodeRuns: (name) => {
      loads.nodeRuns += 1;
      return Promise.resolve(nodeRuns.get(name) ?? []);
    },
    applyEvent(id, event) {
      applied.push({ id, event });
      if (source.respond) return source.respond(id, event);
      const current = issues.find((i) => i.id === id) ?? extra.get(id);
      if (!current) return Promise.reject(new Error('issue not found'));
      const status = event.type === 'approve' ? 'resolved' : 'fixing';
      const updatedAt = new Date(Date.parse(current.updatedAt) + 60_000).toISOString();
      return Promise.resolve({ ...current, status, updatedAt });
    },
    send(payload) {
      const parsed = parseIssueUpdated(payload);
      if (parsed) act(() => feed?.update(parsed));
    },
    sendRun(event, payload) {
      const parsed = parseRunEvent(event, payload);
      if (parsed) act(() => feed?.run(parsed));
    },
    sendNode(payload) {
      const parsed = parseNodeUpdated(payload);
      if (parsed) act(() => feed?.node(parsed));
    },
    reconnect() {
      act(() => {
        feed?.status('reconnecting');
        feed?.status('live');
        feed?.synced();
        feed?.resetNodes(source.nodes);
      });
    },
    setStatus(next) {
      act(() => feed?.status(next));
    },
  };
  return source;
}

/** Renders `ui` at `path` with the live store on `source`, and the routes the pages link to. */
export function renderWithIssues(
  ui: ReactNode,
  source: IssueSource,
  { path = '/', route = '*' }: { path?: string; route?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <IssuesProvider source={source}>
        <Routes>
          <Route path={route} element={ui} />
        </Routes>
      </IssuesProvider>
    </MemoryRouter>,
  );
}
