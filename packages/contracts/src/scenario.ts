import { z } from 'zod';

// The error-tracking agent's classes (README, step 2).
export const BUG_CLASSES = ['frontend', 'backend-api', 'database', 'infra-config'] as const;

/** `meta.json` in each `scenarios/<id>/` directory (#6). */
export const scenarioMetaSchema = z.strictObject({
  class: z.enum(BUG_CLASSES),
  // The lowest tier expected to fix the bug.
  expectedTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  description: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\n]*$/, 'one line'),
});

export type ScenarioMeta = z.infer<typeof scenarioMetaSchema>;
