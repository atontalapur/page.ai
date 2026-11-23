import {
  approvalSchema,
  issueEventRecordSchema,
  issueRunSchema,
  issueSchema,
  nodeRunSchema,
  nodeSummarySchema,
  sessionSchema,
  UI_NAMESPACE,
  type Approval,
  type Issue,
  type IssueEvent,
  type IssueEventRecord,
  type IssueRun,
  type NodeRun,
  type NodeSummary,
  type ServerToUiEvents,
  type Session,
  type SocketRefusal,
  type UiToServerEvents,
} from '@page/contracts';
import { io, type Socket } from 'socket.io-client';

import {
  parseApproval,
  parseIssueUpdated,
  parseNodeUpdated,
  parseRunEvent,
  RUN_EVENTS,
  type ApprovalDecision,
  type IssueFeed,
  type IssueSource,
} from './source';

const issueList = issueSchema.array();
const runList = issueRunSchema.array();
const eventList = issueEventRecordSchema.array();
const nodeList = nodeSummarySchema.array();
const nodeRunList = nodeRunSchema.array();
const approvalList = approvalSchema.array();

// The server counts handshakes per minute; one that refuses for that is waited out.
const RATE_LIMIT_RETRY_MS = 60_000;

class Unauthorized extends Error {}

/**
 * The orchestrator this page was served from. The socket connects first, then the lists are
 * loaded from GET /issues and GET /nodes, so no change made during the load is missed: the
 * store keeps whichever copy of an issue is newer, and a `node.updated` that lands during the
 * load is applied again after it. Each reconnect loads both lists again, for the changes made
 * while the socket was down, and tells the store (`synced`) so loaded runs are loaded again.
 *
 * `token` is the shared API token or a person's dashboard token. A personal token names its
 * holder, and the server records this tab's Tier 3 decisions under that name. With the shared
 * token, `name` (sent as `auth.name` in the handshake) is used instead while the server has no
 * personal tokens, and a tab with none can't decide.
 */
export function serverSource(token: string, name?: string): IssueSource {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  let approver = name;
  const auth = () => (approver === undefined ? { token } : { token, name: approver });
  let socket: Socket<ServerToUiEvents, UiToServerEvents> | undefined;

  async function get(path: string): Promise<Response> {
    const res = await fetch(path, { headers });
    if (res.status === 401) throw new Unauthorized();
    return res;
  }

  return {
    start(feed: IssueFeed) {
      let retry: ReturnType<typeof setTimeout> | undefined;
      const current: Socket<ServerToUiEvents, UiToServerEvents> = io(UI_NAMESPACE, {
        auth: auth(),
      });
      socket = current;
      feed.status('connecting');

      // The node.updated events that arrive while GET /nodes is loading, to apply after it.
      let nodesLoading: NodeSummary[] | undefined;

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

      async function loadNodes() {
        const during: NodeSummary[] = [];
        nodesLoading = during;
        try {
          const res = await get('/nodes');
          const nodes = nodeList.safeParse(await res.json());
          if (!nodes.success) {
            console.warn('GET /nodes returned daemons that break the contract');
            return;
          }
          feed.resetNodes(nodes.data);
          for (const node of during) feed.node(node);
        } catch (err) {
          // A refused token shows up on GET /issues, which asks for a new one.
          if (!(err instanceof Unauthorized)) console.warn('could not load node daemons', err);
        } finally {
          if (nodesLoading === during) nodesLoading = undefined;
        }
      }

      current.on('connect', () => {
        feed.status('live');
        feed.synced();
        void load();
        void loadNodes();
      });
      current.on('issue.updated', (payload: unknown) => {
        const issue = parseIssueUpdated(payload);
        if (issue) feed.update(issue);
      });
      current.on('node.updated', (payload: unknown) => {
        const node = parseNodeUpdated(payload);
        if (!node) return;
        nodesLoading?.push(node);
        feed.node(node);
      });
      // The typed on() wants each event as a literal; the payload is parsed here.
      const on = current.on.bind(current) as (
        event: string,
        fn: (payload: unknown) => void,
      ) => void;
      for (const event of RUN_EVENTS) {
        on(event, (payload) => {
          const parsed = parseRunEvent(event, payload);
          if (parsed) feed.run(parsed);
        });
      }
      for (const event of ['approval.requested', 'approval.updated'] as const) {
        current.on(event, (payload: unknown) => {
          const approval = parseApproval(event, payload);
          if (approval) feed.approval(approval);
        });
      }
      current.on('disconnect', () => feed.status('reconnecting'));
      current.on('connect_error', (err) => {
        // A refusal from the server's middleware is final for socket.io-client; anything
        // else (server down, network gone) it retries on its own.
        const refused = (refusal: SocketRefusal) => err.message === refusal;
        if (refused('unauthorized')) return feed.status('needs_token');
        feed.status('reconnecting');
        if (refused('rate_limited')) {
          retry = setTimeout(() => current.connect(), RATE_LIMIT_RETRY_MS);
        }
      });

      return () => {
        clearTimeout(retry);
        current.close();
        if (socket === current) socket = undefined;
      };
    },

    decideApproval(approvalId: string, decision: ApprovalDecision) {
      socket?.emit('approval.decide', { v: 1, approvalId, decision });
    },

    setApproverName(next: string) {
      approver = next;
      if (socket === undefined) return;
      // The name goes in the handshake, so it takes a new connection.
      socket.auth = auth();
      socket.disconnect().connect();
    },

    async fetchSession(): Promise<Session | undefined> {
      try {
        const res = await get('/me');
        if (!res.ok) return undefined;
        const session = sessionSchema.safeParse(await res.json());
        return session.success ? session.data : undefined;
      } catch {
        return undefined;
      }
    },

    async fetchApprovals(id: string): Promise<Approval[] | undefined> {
      try {
        const res = await get(`/approvals?issueId=${encodeURIComponent(id)}`);
        if (!res.ok) return undefined;
        const approvals = approvalList.safeParse(await res.json());
        return approvals.success ? approvals.data : undefined;
      } catch {
        return undefined;
      }
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

    async fetchEvents(id: string): Promise<IssueEventRecord[] | undefined> {
      try {
        const res = await get(`/issues/${encodeURIComponent(id)}/events`);
        if (!res.ok) return undefined;
        const events = eventList.safeParse(await res.json());
        return events.success ? events.data : undefined;
      } catch {
        return undefined;
      }
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

    async fetchNodeRuns(name: string): Promise<NodeRun[] | undefined> {
      try {
        const res = await get(`/nodes/${encodeURIComponent(name)}/runs`);
        if (!res.ok) return undefined;
        const runs = nodeRunList.safeParse(await res.json());
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
