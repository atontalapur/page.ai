import {
  serverToUiEvents,
  type Approval,
  type DecidedApproval,
  type Issue,
  type IssueEvent,
  type IssueEventRecord,
  type IssueRun,
  type NodeRun,
  type NodeSummary,
  type ServerToUiEvents,
} from '@page/contracts';

/**
 * Where a source stands. `needs_token` means the server refused the token, or there is none
 * yet; `mock` means no server is connected and the mock source is playing events.
 */
export type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'needs_token' | 'mock';

type Payload<E extends keyof ServerToUiEvents> = Parameters<ServerToUiEvents[E]>[0];

/** The run events a source passes on, as the socket names them. */
export const RUN_EVENTS = ['run.started', 'run.step', 'run.diff', 'run.finished'] as const;

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
      return event.payload.runId;
  }
}
