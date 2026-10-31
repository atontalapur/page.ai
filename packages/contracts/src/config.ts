import { z } from 'zod';

// Env schemas, parsed once at boot (#24). A shared base plus one extension per app.
// `z.object` drops the unrelated vars `process.env` carries.

// pino's levels.
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

const secret = z.string().min(1);

/** Vars both the orchestrator and the node daemon read. */
export const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // Swaps every external adapter (PostHog, Twilio, OpenRouter, GitHub, Docker) for its fake.
  USE_FAKE_ADAPTERS: z.stringbool().default(false),
  // pg-boss and the app tables share one database.
  DATABASE_URL: z.url(),
  // The node daemon authenticates its socket to the orchestrator with this.
  NODE_SHARED_SECRET: secret,
});

/** With real adapters on, these optional vars become required. */
function requireUnlessFake(keys: readonly string[]) {
  return (config: Record<string, unknown>, ctx: z.RefinementCtx) => {
    if (config.USE_FAKE_ADAPTERS) return;
    for (const key of keys) {
      if (config[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required unless USE_FAKE_ADAPTERS is set`,
        });
      }
    }
  };
}

export const orchestratorConfigSchema = baseConfigSchema
  .extend({
    PORT: z.coerce.number().int().positive().default(3000),
    POSTHOG_WEBHOOK_SECRET: secret,
    OPENROUTER_API_KEY: secret.optional(),
    TWILIO_ACCOUNT_SID: secret.optional(),
    TWILIO_AUTH_TOKEN: secret.optional(),
    TWILIO_FROM_NUMBER: secret.optional(),
    // Comma-separated phone numbers to call or text (#31).
    NOTIFY_TO_NUMBERS: z
      .string()
      .transform((list) =>
        list
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean),
      )
      .optional(),
  })
  .superRefine(
    requireUnlessFake([
      'OPENROUTER_API_KEY',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
      'NOTIFY_TO_NUMBERS',
    ]),
  );

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;

export const nodeConfigSchema = baseConfigSchema
  .extend({
    ORCHESTRATOR_URL: z.url(),
    OPENROUTER_API_KEY: secret.optional(),
    // The fine-grained token and demo repo agents push to (#10).
    GITHUB_TOKEN: secret.optional(),
    GITHUB_REPO: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name')
      .optional(),
  })
  .superRefine(requireUnlessFake(['OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO']));

export type NodeConfig = z.infer<typeof nodeConfigSchema>;

/** The demo app reports to PostHog only when a key is set; otherwise it uses a fake (#2). */
export const demoAppConfigSchema = z.object({
  POSTHOG_KEY: secret.optional(),
  POSTHOG_HOST: z.url().default('https://us.i.posthog.com'),
});

export type DemoAppConfig = z.infer<typeof demoAppConfigSchema>;
