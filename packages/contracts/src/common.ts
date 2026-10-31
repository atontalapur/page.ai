import { z } from 'zod';

// The error-tracking agent's classes (README, step 2).
export const BUG_CLASSES = ['frontend', 'backend-api', 'database', 'infra-config'] as const;

/** Every id on the wire is a uuid. */
export const idSchema = z.uuid();

/** Timestamps travel as ISO 8601 UTC strings ending in `Z`, so JSON keeps them unchanged. */
export const timestampSchema = z.iso.datetime();

export const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export type Tier = z.infer<typeof tierSchema>;

/**
 * PostHog's error-tracking issue id. It's the unique key on `issues` and the pg-boss
 * `singletonKey` for fix jobs, so one issue never has two fix runs at once.
 */
export const fingerprintSchema = z.string().min(1);
