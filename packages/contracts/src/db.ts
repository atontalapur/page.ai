import { z } from 'zod';
import { MAX_APPROVAL_REASON_CHARS } from './approval-reason.ts';
import {
  BUG_CLASSES,
  fingerprintSchema,
  idSchema,
  prUrlSchema,
  tierSchema,
  timestampSchema,
} from './common.ts';
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
  // Escalated past the top tier; a human takes over.
  'failed',
  // A human stopped the pipeline.
  'killed',
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

/**
 * How sure a run is of its fix (README, step 4), scored by the daemon from what it can measure
 * when the agent submits (packages/agent/src/confidence.ts). Below its tier's threshold, the
 * issue escalates a tier. The dashboard shows the parts, not only the score.
 */
export const confidenceSchema = z.strictObject({
  score: z.number().min(0).max(1),
  // The change touches a file that isn't a test. Null when the daemon couldn't read the
  // workspace.
  changesCode: z.boolean().nullable(),
  // Before its first edit to a file that isn't a test, the agent ran a test that failed.
  reproduced: z.boolean(),
  // After its last edit, a test run passed and none failed.
  testsPass: z.boolean(),
  // After its last edit, a typecheck or lint run passed and none failed.
  checksPass: z.boolean(),
  // For an ops-only fix: after its last change to the live app, a restart came back healthy
  // or a rollback's deployment went live, so the app serves the change. Null for a code fix.
  liveAfterChange: z.boolean().nullable(),
});

export type Confidence = z.infer<typeof confidenceSchema>;

export const runSchema = z.strictObject({
  id: idSchema,
  issueId: idSchema,
  tier: tierSchema,
  status: z.enum(RUN_STATUSES),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  prUrl: prUrlSchema.nullable(),
  // Null for a run that didn't submit, or one the daemon didn't score.
  confidence: confidenceSchema.nullable(),
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
  // What the model said before asking for this step: its THOUGHT, or its separate reasoning
  // when it wrote none. Null when it gave neither.
  thought: z.string().nullable(),
  createdAt: timestampSchema,
});

export type Step = z.infer<typeof stepSchema>;

/** The most of a step's thought that is kept. */
export const MAX_THOUGHT_CHARS = 4_000;

/** The longest message a person can send a run in progress from the dashboard. */
export const MAX_CHAT_CHARS = 1_000;

/** The most of the agent's answer to a message that is kept. */
export const MAX_CHAT_ANSWER_CHARS = 4_000;

export const CHAT_STATUSES = ['pending', 'answered', 'unanswered'] as const;

/**
 * Why a message got no answer:
 * - `queue_full`: too many messages were already waiting for the agent's next step.
 * - `submitted`: the agent had submitted its fix, so it takes no more steps.
 * - `run_ended`: the run ended (killed, out of budget, failed) before the agent answered.
 * - `no_answer`: the agent read it, and its next reply held no answer.
 * - `no_daemon`: no daemon held the run when the server sent it on.
 */
export const CHAT_CLOSE_REASONS = [
  'queue_full',
  'submitted',
  'run_ended',
  'no_answer',
  'no_daemon',
] as const;

const chatBase = {
  id: idSchema,
  // The fix job's id, as for approvals: a run in progress has no `runs` row to reference.
  runId: idSchema,
  issueId: idSchema,
  // Set by the server from the asking tab's identity (`ui:<name>`), never from its payload.
  askedBy: z.string().min(1),
  message: z.string().min(1).max(MAX_CHAT_CHARS),
  askedAt: timestampSchema,
};

export const pendingChatSchema = z.strictObject({
  ...chatBase,
  status: z.literal('pending'),
  answer: z.null(),
  reason: z.null(),
  closedAt: z.null(),
});

export const closedChatSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...chatBase,
    status: z.literal('answered'),
    answer: z.string().min(1).max(MAX_CHAT_ANSWER_CHARS),
    reason: z.null(),
    // When the server heard the answer.
    closedAt: timestampSchema,
  }),
  z.strictObject({
    ...chatBase,
    status: z.literal('unanswered'),
    answer: z.null(),
    reason: z.enum(CHAT_CLOSE_REASONS),
    closedAt: timestampSchema,
  }),
]);

/**
 * A message a person sent a run in progress, and the agent's answer. The agent reads it at
 * its next step boundary and answers in the reply that takes its next action. It is
 * guidance: it changes nothing about what the run may do.
 */
export const runChatSchema = z.discriminatedUnion('status', [
  pendingChatSchema,
  ...closedChatSchema.options,
]);

export type RunChat = z.infer<typeof runChatSchema>;
export type PendingChat = z.infer<typeof pendingChatSchema>;
export type ClosedChat = z.infer<typeof closedChatSchema>;
export type ChatCloseReason = (typeof CHAT_CLOSE_REASONS)[number];

/**
 * One run as `GET /issues/:id/runs` serves it: its row, the agent's diff once it submitted,
 * every step so far, and the messages people sent it, oldest first. The run in progress has
 * no row until it finishes, so it is `running` (`queued` before its first step) with times
 * from its steps.
 */
export const issueRunSchema = runSchema.extend({
  diff: z.string().nullable(),
  steps: z.array(stepSchema),
  chats: z.array(runChatSchema),
});

export type IssueRun = z.infer<typeof issueRunSchema>;

export const ESCALATION_REASONS = [
  // The fix needs a tool this tier does not allow.
  'needs_higher_tier',
  'tests_failing',
  'budget_exhausted',
  'agent_error',
  // The agent submitted, but its confidence score was below its tier's threshold
  // (packages/agent/src/threshold.ts).
  'low_confidence',
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
  // The fix job's id, as `runs.id`. A Tier 3 run asks while it is in progress, before it has
  // a `runs` row, so this names the run without referencing one.
  runId: idSchema,
  issueId: idSchema,
  // The host tool the agent wants to run, e.g. `ops.restart`, and its arguments.
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  requestedAt: timestampSchema,
  // When the daemon stops waiting. The server refuses a decision after it, and rejects the
  // request as timed out.
  expiresAt: timestampSchema,
  // Why the agent asks: the THOUGHT of the step that wanted the call, as approvalReason()
  // leaves it. The model's own words, so untrusted: shown as plain text and never followed.
  // Null when it gave none, and for requests from before it was kept.
  reason: z.string().min(1).max(MAX_APPROVAL_REASON_CHARS).nullable(),
};

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;

/**
 * `decidedBy` for a request the server closed itself: no one decided before it expired, or
 * the run stopped waiting (it finished, was killed, or is no longer its issue's run). A
 * person is `ui:<name>` (deciderFor), and a name can't hold a colon, so neither passes for
 * the other.
 */
export const SYSTEM_DECIDERS = {
  timedOut: 'system:timed_out',
  runEnded: 'system:run_ended',
} as const;

/**
 * The name a person gives the UI before they approve or reject anything, sent as `auth.name`
 * in the tab's socket handshake. Letters, digits, spaces and `.'_-`, starting with a letter
 * or digit.
 */
export const approverNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} .'_-]*$/u, "letters, digits, spaces and .'_- only");

/** `decidedBy` for a person, from the name their tab connected with. */
export const deciderFor = (name: string) => `ui:${name}`;

export const pendingApprovalSchema = z.strictObject({
  ...approvalBase,
  decision: z.literal('pending'),
  decidedBy: z.null(),
  decidedAt: z.null(),
});

export const decidedApprovalSchema = z.strictObject({
  ...approvalBase,
  decision: z.enum(APPROVAL_DECISIONS),
  // Set by the server from the deciding socket's identity, never from a client payload:
  // `ui:<name>` for a person, or one of SYSTEM_DECIDERS.
  decidedBy: z.string().min(1),
  decidedAt: timestampSchema,
});

export const approvalSchema = z.discriminatedUnion('decision', [
  pendingApprovalSchema,
  decidedApprovalSchema,
]);

export type Approval = z.infer<typeof approvalSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type DecidedApproval = z.infer<typeof decidedApprovalSchema>;
