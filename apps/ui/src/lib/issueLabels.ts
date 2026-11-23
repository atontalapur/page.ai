import {
  TERMINAL_ISSUE_STATUSES,
  type BugClass,
  type Issue,
  type IssueStatus,
  type Run,
  type Severity,
} from '@page/contracts';

export const statusLabels: Record<IssueStatus, string> = {
  new: 'New',
  triaged: 'Triaged',
  fixing: 'Fixing',
  pr_open: 'PR open',
  awaiting_approval: 'Awaiting approval',
  resolved: 'Resolved',
  failed: 'Failed',
  killed: 'Killed',
};

export const runStatusLabels: Record<Run['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Patch ready',
  escalated: 'Escalated',
  failed: 'Failed',
  killed: 'Killed',
};

export const severityLabels: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const classLabels: Record<BugClass, string> = {
  frontend: 'Frontend',
  'backend-api': 'Backend API',
  database: 'Database',
  'infra-config': 'Infra config',
};

/** Class and severity are null until triage runs. */
export const UNTRIAGED = 'Untriaged';

export function severityLabel(severity: Severity | null): string {
  return severity ? severityLabels[severity] : UNTRIAGED;
}

export function classLabel(bugClass: BugClass | null): string {
  return bugClass ? classLabels[bugClass] : UNTRIAGED;
}

export function tierLabel(tier: Issue['currentTier']): string {
  return tier === null ? 'None' : `Tier ${tier}`;
}

/** The first block of the uuid, which is enough to tell issues apart on screen. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function isOpen(issue: Issue): boolean {
  return !(TERMINAL_ISSUE_STATUSES as readonly IssueStatus[]).includes(issue.status);
}
