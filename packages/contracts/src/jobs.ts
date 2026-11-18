import { z } from 'zod';
import { fingerprintSchema, idSchema, tierSchema, timestampSchema } from './common.ts';
import { escalationNoteSchema } from './escalation.ts';
import { nodeRunFinishedSchema } from './events.ts';

// pg-boss payloads (#26). Producers and consumers both parse with these. A breaking change
// bumps `v`, and a consumer rejects a `v` it does not know.

export const triageJobSchema = z.strictObject({
  v: z.literal(1),
  issueId: idSchema,
});

/**
 * Claimed by the node daemon (#8). Every tier uses the one `fix` queue so that `fingerprint`,
 * the pg-boss `singletonKey`, holds across escalations (see `fingerprintSchema`).
 */
export const fixJobSchema = z.strictObject({
  v: z.literal(1),
  issueId: idSchema,
  runId: idSchema,
  tier: tierSchema,
  fingerprint: fingerprintSchema,
  // The error report the agent works from: request line, exception and in-app frames, never
  // the cause. Ingest stores it sanitized (no bodies, headers or user fields), since a Tier 2
  // PR is public. The orchestrator always sends one; the daemon still fails a run without it.
  report: z.string().trim().min(1).optional(),
  // What the tier below left when it escalated to this run. A Tier 2 PR body carries it.
  escalationNote: escalationNoteSchema.optional(),
});

export const NOTIFY_CHANNELS = ['call', 'sms'] as const;

/**
 * One phone's page. v2 (#127) added `to`: each phone gets its own job, so a pg-boss retry
 * pages only the phone that missed it.
 */
export const notifyJobSchema = z.strictObject({
  v: z.literal(2),
  issueId: idSchema,
  channel: z.enum(NOTIFY_CHANNELS),
  // One NOTIFY_TO_NUMBERS entry.
  to: z.string().min(1),
  message: z.string().min(1),
});

/** A diff larger than this is not sent: the run row keeps its PR link, or nothing. */
export const MAX_RUN_DIFF_CHARS = 1_000_000;

/**
 * Sent by the node daemon when a fix run ends, so the orchestrator records it (#136). The
 * queue is durable where the socket is best effort: the `runs` row, the issue event, the
 * escalation and the next tier's job all come from this. `result` is `node.run.finished`.
 */
export const runFinishedJobSchema = z
  .strictObject({
    v: z.literal(1),
    issueId: idSchema,
    // The fix job's tier, which the run row and an escalation's `fromTier` record.
    tier: tierSchema,
    // When the daemon claimed the job, and when the run ended.
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    // The agent's `git diff` when it submitted. Null otherwise, or when it was over the cap.
    diff: z.string().max(MAX_RUN_DIFF_CHARS).nullable(),
    result: nodeRunFinishedSchema,
  })
  .refine((job) => job.result.status !== 'escalated' || job.result.toTier > job.tier, {
    path: ['result', 'toTier'],
    message: 'must be above the run tier',
  });

/** Queue name to payload schema. */
export const jobSchemas = {
  triage: triageJobSchema,
  fix: fixJobSchema,
  notify: notifyJobSchema,
  run_finished: runFinishedJobSchema,
} as const;

export type QueueName = keyof typeof jobSchemas;

export type JobPayload<Q extends QueueName> = z.infer<(typeof jobSchemas)[Q]>;
