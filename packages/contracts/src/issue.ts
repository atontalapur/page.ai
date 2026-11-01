import { z } from 'zod';

export const issueCategory = z.enum(['frontend', 'backend', 'database', 'infra']);
export type IssueCategory = z.infer<typeof issueCategory>;

export const severity = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof severity>;

/** Fix agents start at tier 1 and escalate one tier at a time. */
export const MAX_TIER = 3;
export const tier = z.int().min(1).max(MAX_TIER);
export type Tier = z.infer<typeof tier>;

/**
 * - detected: reported, not yet classified
 * - triaged: classified, waiting for a fix agent
 * - fixing: a fix job is queued or running at `tier`
 * - awaiting_approval: a patch is ready for a human
 * - resolved: the patch was approved
 * - unresolved: escalated past the top tier, a human takes over
 * - killed: a human stopped the pipeline
 */
export const issueStatus = z.enum([
  'detected',
  'triaged',
  'fixing',
  'awaiting_approval',
  'resolved',
  'unresolved',
  'killed',
]);
export type IssueStatus = z.infer<typeof issueStatus>;

/** No event leaves these statuses. A recurrence opens a new issue. */
export const terminalStatuses = [
  'resolved',
  'unresolved',
  'killed',
] as const satisfies readonly IssueStatus[];

export const issue = z.object({
  id: z.uuid(),
  /** Stable key for one error, so repeats count as occurrences instead of new issues. */
  fingerprint: z.string(),
  title: z.string(),
  status: issueStatus,
  category: issueCategory.nullable(),
  severity: severity.nullable(),
  tier: tier.nullable(),
  occurrences: z.int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type Issue = z.infer<typeof issue>;

export const newIssue = z.object({
  fingerprint: z.string().trim().min(1).max(512),
  title: z.string().trim().min(1).max(500),
});
export type NewIssue = z.infer<typeof newIssue>;

const reason = z.string().trim().min(1).max(2000);

/** Everything that moves an issue between statuses. */
export const issueEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('triage'), category: issueCategory, severity }),
  z.object({ type: z.literal('start_fix') }),
  z.object({ type: z.literal('patch_ready') }),
  z.object({ type: z.literal('escalate'), reason }),
  z.object({ type: z.literal('approve') }),
  z.object({ type: z.literal('reject'), reason }),
  z.object({ type: z.literal('kill') }),
]);
export type IssueEvent = z.infer<typeof issueEvent>;

/** One applied event, as the audit log stores it. */
export const issueEventRecord = z.object({
  id: z.string(),
  issueId: z.uuid(),
  event: issueEvent,
  fromStatus: issueStatus,
  toStatus: issueStatus,
  tier: tier.nullable(),
  createdAt: z.iso.datetime(),
});
export type IssueEventRecord = z.infer<typeof issueEventRecord>;
