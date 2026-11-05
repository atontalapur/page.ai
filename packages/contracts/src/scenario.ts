import { z } from 'zod';
import { BUG_CLASSES, tierSchema } from './common.ts';

/** `meta.json` in each `scenarios/<id>/` directory (#6). */
export const scenarioMetaSchema = z.strictObject({
  class: z.enum(BUG_CLASSES),
  // The lowest tier expected to fix the bug.
  expectedTier: tierSchema,
  description: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\n]*$/, 'one line'),
  // What on-call would see, and what the agent gets as its task until ingest (#30) can
  // build one: the request, the status and the error with its stack. It must not say why
  // the bug happens or how to fix it; `description` is for people, and names the cause.
  report: z.string().trim().min(1).max(4_000),
});

export type ScenarioMeta = z.infer<typeof scenarioMetaSchema>;
