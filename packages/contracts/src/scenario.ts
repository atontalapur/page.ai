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
});

export type ScenarioMeta = z.infer<typeof scenarioMetaSchema>;
