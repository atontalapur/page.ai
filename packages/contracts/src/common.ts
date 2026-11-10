import { z } from 'zod';

// The error-tracking agent's classes (README, step 2).
export const BUG_CLASSES = ['frontend', 'backend-api', 'database', 'infra-config'] as const;

/** Every id on the wire is a uuid. */
export const idSchema = z.uuid();

/**
 * Timestamps travel as ISO 8601 strings. Offsets are accepted because Postgres `to_json` on a
 * timestamptz gives `+00:00` with microseconds; every value is normalized to UTC `Z` with
 * millisecond precision (`Date.toISOString()`), so consumers only ever see one format.
 */
export const timestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

/**
 * A pull request link from an agent. The dashboard renders it as a link, so it must be an
 * https github.com URL: `z.url()` alone accepts any scheme, `javascript:` included.
 */
export const prUrlSchema = z.url({ protocol: /^https$/, hostname: /^github\.com$/ });

export const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export type Tier = z.infer<typeof tierSchema>;

/**
 * PostHog's error-tracking issue id. It's the unique key on `issues` and the pg-boss
 * `singletonKey` for triage, fix and notify. pg-boss scopes the key to one queue and enforces
 * it only under a queue policy, so each of those queues is created `exclusive`: one created or
 * active job per fingerprint. Every tier shares the `fix` queue, so the key holds across an
 * escalation. The run a new tier replaces is cancelled in the same transaction, which frees
 * the key.
 */
export const fingerprintSchema = z.string().min(1);
