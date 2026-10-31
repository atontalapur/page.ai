import { z } from 'zod';
import { fingerprintSchema, idSchema } from './common.ts';

// pg-boss payloads (#26). Producers and consumers both parse with these. A breaking change
// bumps `v`, and a consumer rejects a `v` it does not know.

export const triageJobSchema = z.strictObject({
  v: z.literal(1),
  issueId: idSchema,
});

/** Claimed by the node daemon (#8). `fingerprint` is the pg-boss `singletonKey`. */
export const fixJobSchema = z.strictObject({
  v: z.literal(1),
  issueId: idSchema,
  runId: idSchema,
  fingerprint: fingerprintSchema,
});

export const NOTIFY_CHANNELS = ['call', 'sms'] as const;

export const notifyJobSchema = z.strictObject({
  v: z.literal(1),
  issueId: idSchema,
  channel: z.enum(NOTIFY_CHANNELS),
  message: z.string().min(1),
});

/** Queue name to payload schema. */
export const jobSchemas = {
  triage: triageJobSchema,
  'fix.tier1': fixJobSchema,
  'fix.tier2': fixJobSchema,
  'fix.tier3': fixJobSchema,
  notify: notifyJobSchema,
} as const;

export type QueueName = keyof typeof jobSchemas;

export type JobPayload<Q extends QueueName> = z.infer<(typeof jobSchemas)[Q]>;
