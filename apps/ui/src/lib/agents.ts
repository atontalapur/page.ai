import type { NodeRun, NodeSummary } from '@page/contracts';

import { isFinished } from '../live/runs';

/**
 * An agent is a node daemon. It is running while it holds a run, idle while it is connected
 * with none, and offline once it has no socket to the orchestrator.
 */
export type AgentStatus = 'running' | 'idle' | 'offline';

export const AGENT_STATUSES: readonly AgentStatus[] = ['running', 'idle', 'offline'];

export const agentStatusLabels: Record<AgentStatus, string> = {
  running: 'Running',
  idle: 'Idle',
  offline: 'Offline',
};

/**
 * The runs this daemon is still working. `current` can keep a run after it escalated, failed
 * or was killed, until a later heartbeat drops it. Those are not in progress.
 */
export function inProgress(node: NodeSummary): NodeRun[] {
  return node.current.filter((run) => !isFinished(run));
}

export function agentStatus(node: NodeSummary): AgentStatus {
  if (!node.connected) return 'offline';
  return inProgress(node).length > 0 ? 'running' : 'idle';
}

/** Running agents first, then idle, then offline, each by name. */
export function byActivity(a: NodeSummary, b: NodeSummary): number {
  const order = AGENT_STATUSES.indexOf(agentStatus(a)) - AGENT_STATUSES.indexOf(agentStatus(b));
  return order !== 0 ? order : a.name.localeCompare(b.name);
}

const time = (at: string) => new Date(at).toLocaleString();

/** Whether the agent is connected, and since when, as one line. */
export function presence(node: NodeSummary): string {
  if (node.connected) return node.since ? `Connected since ${time(node.since)}` : 'Connected';
  return node.since ? `Offline since ${time(node.since)}` : 'Offline';
}

/** When the agent took its newest run, as one line. */
export function lastRunLine(node: NodeSummary): string {
  return node.lastRunAt ? `Last run started ${time(node.lastRunAt)}` : 'No runs yet';
}
