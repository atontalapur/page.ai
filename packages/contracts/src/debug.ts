import { z } from 'zod';

/**
 * The test errors the dashboard's Debugging page can create on staging, each through a
 * different part of the system:
 * - `checkout`: an ops bug (scenario 029). A runtime setting sends shipping past int4, so a
 *   real checkout on the live demo app fails with a 500. Everything runs: PostHog, ingest,
 *   triage, the page, and a fix that has to reach Tier 3 to undo the setting.
 * - `code_bug`: requests the product route, which throws while a code bug such as 016 is
 *   live on the demo app. A Tier 1 fix can patch it.
 * - `synthetic`: sends one exception straight to PostHog. Ingest, triage and the page run,
 *   but nothing in the app is broken, so there is nothing for a fix to find.
 */
export const DEBUG_ERRORS = ['checkout', 'code_bug', 'synthetic'] as const;
export type DebugErrorKind = (typeof DEBUG_ERRORS)[number];

export const debugErrorRequestSchema = z.strictObject({ kind: z.enum(DEBUG_ERRORS) });
export type DebugErrorRequest = z.infer<typeof debugErrorRequestSchema>;

/** What creating a test error, or resetting the demo app, did. */
export const debugResultSchema = z.strictObject({
  ok: z.boolean(),
  /** The demo app's or PostHog's HTTP status for the request that should fail, if one ran. */
  status: z.int().nullable(),
  message: z.string(),
  /** A link to follow up, such as the PR that plants the test bug. */
  url: z.string().optional(),
});
export type DebugResult = z.infer<typeof debugResultSchema>;

/** The staging demo app as the Debugging page shows it. */
export const debugStateSchema = z.strictObject({
  demoAppUrl: z.string(),
  healthy: z.boolean(),
  /** Runtime settings overridden through the ops API, such as the checkout bug's. */
  overrides: z.array(z.strictObject({ key: z.string(), value: z.string() })),
  /** The home page search fails now: the test bug is live. Null when that couldn't be told. */
  codeBugLive: z.boolean().nullable(),
  /** When the checkout break clears itself, or null when it isn't set from here. */
  checkoutResetAt: z.string().nullable(),
  /** PostHog is set, so a synthetic exception can be sent. */
  canSendSynthetic: z.boolean(),
});
export type DebugState = z.infer<typeof debugStateSchema>;
