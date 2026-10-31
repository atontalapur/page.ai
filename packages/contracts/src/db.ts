import { z } from 'zod';
import { BUG_CLASSES, fingerprintSchema, idSchema, tierSchema, timestampSchema } from './common.ts';
import { escalationNoteSchema } from './escalation.ts';

// Row shapes for the tables in #25. Fields are camelCase; the DB layer maps column names.

// Transitions are enforced by IssueStateMachine (#27), not here.
export const ISSUE_STATUSES = [
  'new',
  'triaged',
  'fixing',
  'pr_open',
  'awaiting_approval',
  'resolved',
  'failed',
] as const;

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export const issueSchema = z.strictObject({
  id: idSchema,
  fingerprint: fingerprintSchema,
  // Exception type and message, for triage and the UI.
  title: z.string().min(1),
  status: z.enum(ISSUE_STATUSES),
  // Class and severity are null until triage (#30) runs; currentTier until a fix starts.
  class: z.enum(BUG_CLASSES).nullable(),
  severity: z.enum(SEVERITIES).nullable(),
  occurrences: z.int().positive(),
  currentTier: tierSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type Issue = z.infer<typeof issueSchema>;

export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'escalated',
  'failed',
  'killed',
] as const;

export const runSchema = z.strictObject({
  id: idSchema,
  issueId: idSchema,
  tier: tierSchema,
  status: z.enum(RUN_STATUSES),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  prUrl: z.url().nullable(),
});

export type Run = z.infer<typeof runSchema>;

// exec: a shell command, edit: the file-edit tool, host_tool: a daemon-side tool (#10).
export const STEP_KINDS = ['exec', 'edit', 'host_tool'] as const;

/** One `execute()` call (#3), refused ones included. Keyed by (runId, seq). */
export const stepSchema = z.strictObject({
  runId: idSchema,
  seq: z.int().nonnegative(),
  kind: z.enum(STEP_KINDS),
  input: z.string(),
  outputTrimmed: z.string(),
  // Null when the command was refused or timed out.
  exitCode: z.int().nullable(),
  allowed: z.boolean(),
  createdAt: timestampSchema,
});

export type Step = z.infer<typeof stepSchema>;

export const ESCALATION_REASONS = [
  // The fix needs a tool this tier does not allow.
  'needs_higher_tier',
  'tests_failing',
  'budget_exhausted',
  'agent_error',
] as const;

export const escalationSchema = z
  .strictObject({
    id: idSchema,
    runId: idSchema,
    fromTier: tierSchema,
    toTier: tierSchema,
    reason: z.enum(ESCALATION_REASONS),
    note: escalationNoteSchema,
    createdAt: timestampSchema,
  })
  .refine((e) => e.toTier > e.fromTier, {
    path: ['toTier'],
    message: 'must be above fromTier',
  });

export type Escalation = z.infer<typeof escalationSchema>;

const approvalBase = {
  id: idSchema,
  runId: idSchema,
  // The host tool the agent wants to run, e.g. `ops.restart`, and its arguments.
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  requestedAt: timestampSchema,
};

export const approvalSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    ...approvalBase,
    decision: z.literal('pending'),
    decidedBy: z.null(),
    decidedAt: z.null(),
  }),
  z.strictObject({
    ...approvalBase,
    decision: z.literal(['approved', 'rejected']),
    decidedBy: z.string().min(1),
    decidedAt: timestampSchema,
  }),
]);

export type Approval = z.infer<typeof approvalSchema>;
