import { z } from 'zod';
import { BUG_CLASSES, idSchema, tierSchema, timestampSchema } from './common.ts';
import { ISSUE_STATUSES, SEVERITIES } from './db.ts';

// Orchestrator API shapes around `issueSchema` (db.ts). Statuses and tiers come from there.

export const MAX_TIER = 3;

export const issueStatusSchema = z.enum(ISSUE_STATUSES);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

export const bugClassSchema = z.enum(BUG_CLASSES);
export type BugClass = z.infer<typeof bugClassSchema>;

export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

/** No event leaves these statuses. A recurrence opens a new issue. */
export const TERMINAL_ISSUE_STATUSES = [
  'resolved',
  'failed',
  'killed',
] as const satisfies readonly IssueStatus[];

export const newIssueSchema = z.strictObject({
  fingerprint: z.string().trim().min(1).max(512),
  title: z.string().trim().min(1).max(500),
});
export type NewIssue = z.infer<typeof newIssueSchema>;

const reason = z.string().trim().min(1).max(2000);

/** Everything that moves an issue between statuses. */
export const issueEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('triage'), class: bugClassSchema, severity: severitySchema }),
  z.strictObject({ type: z.literal('start_fix') }),
  z.strictObject({ type: z.literal('patch_ready') }),
  z.strictObject({ type: z.literal('escalate'), reason }),
  z.strictObject({ type: z.literal('approve') }),
  z.strictObject({ type: z.literal('reject'), reason }),
  z.strictObject({ type: z.literal('kill') }),
]);
export type IssueEvent = z.infer<typeof issueEventSchema>;

/** One applied event, as the audit log stores it. */
export const issueEventRecordSchema = z.strictObject({
  id: z.string(),
  issueId: idSchema,
  event: issueEventSchema,
  fromStatus: issueStatusSchema,
  toStatus: issueStatusSchema,
  currentTier: tierSchema.nullable(),
  createdAt: timestampSchema,
});
export type IssueEventRecord = z.infer<typeof issueEventRecordSchema>;
