import type { ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Issue, IssueEvent, IssueRun } from '@page/contracts';
import { issueFixture } from '@page/contracts/fixtures';

import { IssuesProvider } from './context/IssuesContext';
import { TaskProvider } from './context/TaskContext';
import {
  parseIssueUpdated,
  type FeedStatus,
  type IssueFeed,
  type IssueSource,
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

export interface TestSource extends IssueSource {
  /** Delivers a raw `issue.updated` payload the way the socket does: parsed first. */
  send(payload: unknown): void;
  setStatus(status: FeedStatus): void;
  /** What fetchIssue finds beyond the list. */
  extra: Map<string, Issue>;
  /** What fetchRuns returns per issue; an issue missing here has no runs. */
  runs: Map<string, IssueRun[]>;
  /** Every event applyEvent was given, in order. */
  applied: { id: string; event: IssueEvent }[];
  /** What applyEvent answers; by default the issue with `status` set as the server would. */
  respond?: (id: string, event: IssueEvent) => Promise<Issue>;
}

/** A source that loads `issues` as its list and plays whatever a test sends. */
export function testSource(issues: Issue[], status: FeedStatus = 'live'): TestSource {
  let feed: IssueFeed | undefined;
  const extra = new Map<string, Issue>();
  const runs = new Map<string, IssueRun[]>();
  const applied: { id: string; event: IssueEvent }[] = [];
  const source: TestSource = {
    extra,
    runs,
    applied,
    start(next) {
      feed = next;
      feed.status(status);
      // A refused token stops the source before any list arrives.
      if (status !== 'needs_token') feed.reset(issues);
      return () => {
        feed = undefined;
      };
    },
    fetchIssue: (id) => Promise.resolve(extra.get(id)),
    fetchRuns: (id) => Promise.resolve(runs.get(id) ?? []),
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
        <TaskProvider>
          <Routes>
            <Route path={route} element={ui} />
          </Routes>
        </TaskProvider>
      </IssuesProvider>
    </MemoryRouter>,
  );
}
