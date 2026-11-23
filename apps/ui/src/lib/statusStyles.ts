import type { IssueStatus, Run, Severity } from '@page/contracts';

import type { AgentStatus } from './agents';

// Radix tints only: an a3 fill with step-11 text reads clearly in both themes, and no
// border keeps the pills soft.
const blue = 'bg-blue-a3 text-blue-11';
const violet = 'bg-violet-a3 text-violet-11';
const amber = 'bg-amber-a3 text-amber-11';
const green = 'bg-green-a3 text-green-11';
const red = 'bg-red-a3 text-red-11';
const slate = 'bg-slate-a3 text-slate-11';

export const severityStyles: Record<Severity, string> = {
  critical: red,
  high: amber,
  medium: blue,
  low: slate,
};

/** A severity badge before triage has set one. */
export const untriagedStyle = slate;

export const issueStatusStyles: Record<IssueStatus, string> = {
  new: blue,
  triaged: blue,
  fixing: violet,
  pr_open: amber,
  awaiting_approval: amber,
  resolved: green,
  failed: red,
  killed: slate,
};

export const runStatusStyles: Record<Run['status'], string> = {
  queued: blue,
  running: violet,
  succeeded: green,
  escalated: amber,
  failed: red,
  killed: slate,
};

// Running matches a running run's violet. Offline is amber: a daemon that can't take work is
// worth a look, but it isn't a failure.
export const agentStatusStyles: Record<AgentStatus, string> = {
  running: violet,
  idle: slate,
  offline: amber,
};
