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

/**
 * dotenv sets `KEY=` to `''`, which `.optional()` and `.default()` don't treat as missing.
 * Dropping blank values first makes a copied `.env.example` behave like an unset var.
 */
function blankToUndefined(env: unknown) {
  if (typeof env !== 'object' || env === null) return env;
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value !== 'string' || value.trim() !== ''),
  );
}

/** Wraps an app's env schema so blank vars count as unset. */
export function envSchema<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToUndefined, schema);
}

/**
 * With real adapters on, these optional vars become required. It runs even when other fields
 * fail (`when`), so boot reports every missing var at once; fields may be invalid, hence `?.`.
 */
function requireUnlessFake(keys: readonly string[]) {
  const check = (config: Record<string, unknown> | undefined, ctx: z.RefinementCtx) => {
    if (config?.USE_FAKE_ADAPTERS === true) return;
    for (const key of keys) {
      if (config?.[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required unless USE_FAKE_ADAPTERS is set`,
        });
      }
    }
  };
  return [check, { when: () => true }] as const;
}

// The demo app refuses an ops secret under 32 characters (apps/demo-app/src/ops/auth.ts).
const MIN_OPS_SECRET_LENGTH = 32;

/**
 * OPS_APP_URL needs an OPS_SECRET the demo app accepts. The secret alone is checked only when
 * the URL is set, since it may be there for docker compose. Runs even when other fields fail.
 */
function opsSecretForApp() {
  const check = (config: Record<string, unknown> | undefined, ctx: z.RefinementCtx) => {
    if (config?.OPS_APP_URL === undefined) return;
    const secret = config.OPS_SECRET;
    if (typeof secret !== 'string') {
      ctx.addIssue({
        code: 'custom',
        path: ['OPS_SECRET'],
        message: 'OPS_SECRET is required with OPS_APP_URL',
      });
    } else if (secret.length < MIN_OPS_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPS_SECRET'],
        message: `OPS_SECRET is under ${MIN_OPS_SECRET_LENGTH} characters, which the demo app refuses`,
      });
    }
  };
  return [check, { when: () => true }] as const;
}

export const orchestratorConfigSchema = envSchema(
  baseConfigSchema
    .extend({
      // 4000 locally, so the demo app keeps 3000. Railway injects PORT.
      PORT: z.coerce.number().int().positive().default(4000),
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
        .pipe(z.array(z.string()).min(1, 'needs at least one number'))
        .optional(),
    })
    .superRefine(
      ...requireUnlessFake([
        'OPENROUTER_API_KEY',
        'TWILIO_ACCOUNT_SID',
        'TWILIO_AUTH_TOKEN',
        'TWILIO_FROM_NUMBER',
        'NOTIFY_TO_NUMBERS',
      ]),
    ),
);

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;

export const nodeConfigSchema = envSchema(
  baseConfigSchema
    .extend({
      ORCHESTRATOR_URL: z.url(),
      // Must match the orchestrator's, which creates the `fix` queue there.
      PGBOSS_SCHEMA: z
        .string()
        .regex(/^[a-z_][a-z0-9_]*$/)
        .default('pgboss'),
      // Built from infra/sandbox/Dockerfile.
      SANDBOX_IMAGE: z.string().min(1).default('page-sandbox'),
      OPENROUTER_API_KEY: secret.optional(),
      // An OpenRouter model id, e.g. `openai/gpt-5-mini`.
      OPENROUTER_MODEL: z.string().min(1).optional(),
      // The fine-grained token and demo repo agents push to (#10).
      GITHUB_TOKEN: secret.optional(),
      GITHUB_REPO: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name')
        .optional(),
      // The live demo app whose ops API Tier 3 runs get (#155). Unset, they get none. Not
      // DEMO_APP_URL: .env keeps staging's app there for the e2e test, and a local daemon
      // must not change staging by accident.
      OPS_APP_URL: z.url({ protocol: /^https?$/ }).optional(),
      // That app's OPS_SECRET. Also docker compose's, so it may be set without OPS_APP_URL.
      OPS_SECRET: secret.optional(),
    })
    .superRefine(
      ...requireUnlessFake([
        'OPENROUTER_API_KEY',
        'OPENROUTER_MODEL',
        'GITHUB_TOKEN',
        'GITHUB_REPO',
      ]),
    )
    .superRefine(...opsSecretForApp()),
);

export type NodeConfig = z.infer<typeof nodeConfigSchema>;

/** The demo app reports to PostHog only when a key is set; otherwise it uses a fake (#2). */
export const demoAppConfigSchema = envSchema(
  z.object({
    POSTHOG_KEY: secret.optional(),
    POSTHOG_HOST: z.url().default('https://us.i.posthog.com'),
  }),
);

export type DemoAppConfig = z.infer<typeof demoAppConfigSchema>;
