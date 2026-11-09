import { z } from 'zod';
import { BUG_CLASSES, tierSchema } from './common.ts';

/** `meta.json` in each `scenarios/<id>/` directory (#6). */
export const scenarioMetaSchema = z.strictObject({
  class: z.enum(BUG_CLASSES),
  // The lowest tier expected to fix the bug. It also sets the scenario's kind (below).
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
  // The text of each repo line the report's stack cites, as break.sh leaves it, keyed
  // `path:line`. If one changes, the report points at the wrong code, so the self-test fails
  // (#79). `pnpm scenarios:frames` records it.
  frameLines: z.record(z.string().regex(/^\S+:[1-9]\d*$/, 'path:line'), z.string()).optional(),
});

export type ScenarioMeta = z.infer<typeof scenarioMetaSchema>;

/**
 * How a scenario plants its bug and how the fix is checked. A `code` bug (Tier 1 and 2)
 * lives in the source: break.sh edits it in the sandbox and a patch fixes it. An `ops`
 * bug (Tier 3) lives in the running app's state, such as a config override or a bad
 * deploy: break-ops.sh plants it on a live demo app, and the fix is an ops action
 * (fix-ops.sh), not a patch.
 */
export type ScenarioKind = 'code' | 'ops';

export function scenarioKind(meta: Pick<ScenarioMeta, 'expectedTier'>): ScenarioKind {
  return meta.expectedTier === 3 ? 'ops' : 'code';
}
