import {
  issueRunSchema,
  issueSchema,
  UI_NAMESPACE,
  type Issue,
  type IssueEvent,
  type IssueRun,
  type ServerToUiEvents,
  type SocketRefusal,
  type UiToServerEvents,
} from '@page/contracts';
import { io, type Socket } from 'socket.io-client';

import { parseIssueUpdated, type IssueFeed, type IssueSource } from './source';

const issueList = issueSchema.array();
const runList = issueRunSchema.array();

// The server counts handshakes per minute; one that refuses for that is waited out.
const RATE_LIMIT_RETRY_MS = 60_000;

class Unauthorized extends Error {}

/**
 * The orchestrator this page was served from. The socket connects first, then the list is
 * loaded from GET /issues, so no change made during the load is missed: the store keeps
 * whichever copy of an issue is newer. Each reconnect loads the list again, for the changes
 * made while the socket was down.
 */
export function serverSource(token: string): IssueSource {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };

  async function get(path: string): Promise<Response> {
    const res = await fetch(path, { headers });
    if (res.status === 401) throw new Unauthorized();
    return res;
  }

  return {
    start(feed: IssueFeed) {
      let retry: ReturnType<typeof setTimeout> | undefined;
      const socket: Socket<ServerToUiEvents, UiToServerEvents> = io(UI_NAMESPACE, {
        auth: { token },
      });
      feed.status('connecting');

      async function load() {
        try {
          const res = await get('/issues');
          const issues = issueList.safeParse(await res.json());
          if (issues.success) feed.reset(issues.data);
          else console.warn('GET /issues returned issues that break the contract');
        } catch (err) {
          if (err instanceof Unauthorized) feed.status('needs_token');
          else console.warn('could not load issues', err);
        }
      }

      socket.on('connect', () => {
        feed.status('live');
        void load();
      });
      socket.on('issue.updated', (payload: unknown) => {
        const issue = parseIssueUpdated(payload);
        if (issue) feed.update(issue);
      });
      socket.on('disconnect', () => feed.status('reconnecting'));
      socket.on('connect_error', (err) => {
        // A refusal from the server's middleware is final for socket.io-client; anything
        // else (server down, network gone) it retries on its own.
        const refused = (refusal: SocketRefusal) => err.message === refusal;
        if (refused('unauthorized')) return feed.status('needs_token');
        feed.status('reconnecting');
        if (refused('rate_limited')) {
          retry = setTimeout(() => socket.connect(), RATE_LIMIT_RETRY_MS);
        }
      });

      return () => {
        clearTimeout(retry);
        socket.close();
      };
    },

    async fetchIssue(id: string): Promise<Issue | undefined> {
      try {
        const res = await get(`/issues/${encodeURIComponent(id)}`);
        if (!res.ok) return undefined;
        const issue = issueSchema.safeParse(await res.json());
        return issue.success ? issue.data : undefined;
      } catch {
        return undefined;
      }
    },

    async applyEvent(id: string, event: IssueEvent): Promise<Issue> {
      const res = await fetch(`/issues/${encodeURIComponent(id)}/events`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      const body: unknown = await res.json().catch(() => undefined);
      if (res.ok) {
        const issue = issueSchema.safeParse(body);
        if (issue.success) return issue.data;
        throw new Error('The orchestrator answered with an issue this page cannot read.');
      }
      if (res.status === 401) throw new Error('The orchestrator refused the token.');
      // 409: the issue moved on (another reviewer, a new run) since the page last heard.
      const message =
        typeof body === 'object' && body !== null && 'message' in body ? body.message : undefined;
      throw new Error(
        typeof message === 'string' ? message : `The orchestrator answered ${res.status}.`,
      );
    },

    async fetchRuns(id: string): Promise<IssueRun[] | undefined> {
      try {
        const res = await get(`/issues/${encodeURIComponent(id)}/runs`);
        if (!res.ok) return undefined;
        const runs = runList.safeParse(await res.json());
        return runs.success ? runs.data : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Whether an orchestrator served this page: its /health answers JSON. The Vite dev server
 * answers every path with index.html, so there the UI runs on the mock source.
 */
export async function serverPresent(): Promise<boolean> {
  try {
    const res = await fetch('/health', { headers: { accept: 'application/json' } });
    return (res.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  }
}
