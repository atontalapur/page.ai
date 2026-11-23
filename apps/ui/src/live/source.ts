import {
  serverToUiEvents,
  type Approval,
  type ChatRefusal,
  type DecidedApproval,
  type Issue,
  type IssueEvent,
  type IssueEventRecord,
  type IssueRun,
  type NodeRun,
  type NodeSummary,
  type ServerToUiEvents,
  type Session,
} from '@page/contracts';

/**
 * Where a source stands. `needs_token` means the server refused the token, or there is none
 * yet; `mock` means no server is connected and the mock source is playing events.
 */
export type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'needs_token' | 'mock';

type Payload<E extends keyof ServerToUiEvents> = Parameters<ServerToUiEvents[E]>[0];

/**
 * The run events a source passes on, as the socket names them. A person's message to a run
 * and its answer travel with the run, so a page showing the run's steps shows them too.
 */
export const RUN_EVENTS = [
  'run.started',
  'run.step',
  'run.diff',
  'run.finished',
  'run.chat.asked',
  'run.chat.reply',
  // What the agent is writing and a command is printing, before the step that holds it.
  'run.live',
] as const;

export type RunEventName = (typeof RUN_EVENTS)[number];

/** One run event, by name with its parsed payload. */
export type RunEvent = {
  [E in RunEventName]: { event: E; payload: Payload<E> };
}[RunEventName];

/** What a source tells the store. */
export interface IssueFeed {
  /** A full list: the first load, and again after each reconnect. Newer copies win. */
  reset(issues: Issue[]): void;
  /** One issue opened or changed. */
  update(issue: Issue): void;
  /** A Tier 3 run's request to change the live app, or its decision. */
  approval(approval: Approval): void;
  status(status: FeedStatus): void;
  /**
   * The socket connected, the first time or again. A run loaded before may have missed
   * events sent while the socket was down, so whatever holds one loads it again.
   */
  synced(): void;
  /** A run started, wrote a step, sent its diff or finished. */
  run(event: RunEvent): void;
  /** Every node daemon: the first load, and again after each reconnect. */
  resetNodes(nodes: NodeSummary[]): void;
  /** One daemon connected, left, took a run or let one go. */
  node(node: NodeSummary): void;
}

export type ApprovalDecision = DecidedApproval['decision'];

/**
 * Why a message to the agent didn't go out: the server's reason (ChatRefusal), no live
 * connection to send it on, or no word from the server in time.
 */
export type AskFailure = ChatRefusal | 'offline' | 'timeout';

export interface IssueSource {
  /** Starts feeding, and returns the function that stops it. */
  start(feed: IssueFeed): () => void;
  /** One issue by id, for a detail page whose issue isn't in the list. */
  fetchIssue(id: string): Promise<Issue | undefined>;
  /** An issue's runs with their steps, oldest first, or undefined when they can't be loaded. */
  fetchRuns(id: string): Promise<IssueRun[] | undefined>;
  /** An issue's applied events, oldest first, or undefined when they can't be loaded. */
  fetchEvents(id: string): Promise<IssueEventRecord[] | undefined>;
  /** The runs a daemon worked, newest first, or undefined when they can't be loaded. */
  fetchNodeRuns(name: string): Promise<NodeRun[] | undefined>;
  /**
   * Applies a reviewer's event, such as `approve`, and returns the issue it left. Rejects
   * with a message to show when the server refuses it.
   */
  applyEvent(id: string, event: IssueEvent): Promise<Issue>;
  /** An issue's Tier 3 approvals, oldest first, or undefined when they can't be loaded. */
  fetchApprovals(id: string): Promise<Approval[] | undefined>;
  /**
   * Sends a person's decision on a Tier 3 request. The server records it under the name the
   * source connected with, and every tab hears it back through `approval`.
   */
  decideApproval(approvalId: string, decision: ApprovalDecision): void;
  /** Connects again under `name`, the one the server records decisions with. */
  setApproverName?(name: string): void;
  /**
   * Who the token names (GET /me): a person, or the shared token and whether it may decide.
   * Undefined when it can't be loaded, as from an orchestrator from before /me. A source
   * without it, such as the mock, decides under a name the tab gives.
   */
  fetchSession?(): Promise<Session | undefined>;
  /**
   * Sends a person's message to the agent on a run in progress. Resolves once the server has
   * stored it and sent it to the daemon, or with why it didn't. Every tab then hears the
   * message and, later, the answer as run events.
   */
  askAgent(runId: string, message: string): Promise<AskFailure | undefined>;
}

/**
 * The approval in an `approval.requested` or `approval.updated` payload, or undefined when
 * the payload breaks the contract.
 */
export function parseApproval(
  event: 'approval.requested' | 'approval.updated',
  payload: unknown,
): Approval | undefined {
  const parsed = serverToUiEvents[event].safeParse(payload);
  if (parsed.success) return parsed.data.approval;
  console.warn(`dropped an ${event} that breaks the contract`, parsed.error.issues);
  return undefined;
}

/**
 * The payload of a server event, or undefined when it breaks the contract (a `v` this build
 * doesn't know, a missing field). Both sources pass every event through here, so the mock is
 * held to the same contract as the server.
 */
export function parseEvent<E extends keyof ServerToUiEvents>(
  event: E,
  payload: unknown,
): Payload<E> | undefined {
  const parsed = serverToUiEvents[event].safeParse(payload);
  if (parsed.success) return parsed.data as Payload<E>;
  console.warn(`dropped a ${event} that breaks the contract`, parsed.error.issues);
  return undefined;
}

/** The issue in an `issue.updated` payload, or undefined when the payload breaks the contract. */
export function parseIssueUpdated(payload: unknown): Issue | undefined {
  return parseEvent('issue.updated', payload)?.issue;
}

/** A run event from its name and raw payload, or undefined when the payload breaks the contract. */
export function parseRunEvent(event: RunEventName, payload: unknown): RunEvent | undefined {
  const parsed = parseEvent(event, payload);
  return parsed && ({ event, payload: parsed } as RunEvent);
}

/** The daemon in a `node.updated` payload, or undefined when it breaks the contract. */
export function parseNodeUpdated(payload: unknown): NodeSummary | undefined {
  return parseEvent('node.updated', payload)?.node;
}

/** The run an event is about. */
export function runIdOf(event: RunEvent): string {
  switch (event.event) {
    case 'run.started':
    case 'run.finished':
      return event.payload.run.id;
    case 'run.step':
      return event.payload.step.runId;
    case 'run.diff':
    case 'run.live':
      return event.payload.runId;
    case 'run.chat.asked':
    case 'run.chat.reply':
      return event.payload.chat.runId;
  }
}
