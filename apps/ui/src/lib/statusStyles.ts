import type { IssueStatus, Run, Severity } from '@page/contracts';

import type { AgentStatus } from '../data/mockAgents';

const blue =
  'border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300';
const purple =
  'border-purple-200 bg-purple-100 text-purple-800 dark:border-purple-900 dark:bg-purple-950 dark:text-purple-300';
const amber =
  'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300';
const green =
  'border-green-200 bg-green-100 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300';
const red =
  'border-red-200 bg-red-100 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300';
const orange =
  'border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-300';
const yellow =
  'border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-300';
const gray =
  'border-gray-200 bg-gray-100 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300';

export const severityStyles: Record<Severity, string> = {
  critical: red,
  high: orange,
  medium: yellow,
  low: blue,
};

/** A severity badge before triage has set one. */
export const untriagedStyle = gray;

export const issueStatusStyles: Record<IssueStatus, string> = {
  new: blue,
  triaged: blue,
  fixing: purple,
  pr_open: amber,
  awaiting_approval: amber,
  resolved: green,
  failed: red,
  killed: gray,
};

export const runStatusStyles: Record<Run['status'], string> = {
  queued: blue,
  running: purple,
  succeeded: green,
  escalated: amber,
  failed: red,
  killed: gray,
};

export const agentStatusStyles: Record<AgentStatus, string> = {
  Running: green,
  Idle: gray,
  Failed: red,
};
