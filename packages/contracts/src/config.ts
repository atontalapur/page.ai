import { z } from 'zod';
import { nodeNameSchema } from './nodes.ts';

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

// The hosts plain http is allowed for, as in the e2e harness (eval/src/e2e-app.ts).
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The ops API's base URL. https, or http on this machine only, since every call carries
 * OPS_SECRET as its bearer token. No user, password, query or fragment, which the ops client
 * can't send or join paths onto.
 */
const opsAppUrl = z
  .url({ protocol: /^https?$/ })
  // zod runs these even when the URL check failed, so each skips what isn't a URL, and the
  // http rule skips other schemes: the URL check has already reported those.
  .refine((raw) => {
    if (!URL.canParse(raw)) return true;
    const url = new URL(raw);
    return url.protocol !== 'http:' || LOOPBACK_HOSTS.includes(url.hostname);
  }, 'use https, or http only for localhost, 127.0.0.1 or [::1], so OPS_SECRET is not sent in the clear')
  .refine((raw) => {
    if (!URL.canParse(raw)) return true;
    const url = new URL(raw);
    return url.username === '' && url.password === '' && !/[?#]/.test(raw);
  }, 'takes no user, password, query or fragment');

// The demo app refuses an ops secret under 32 characters (apps/demo-app/src/ops/auth.ts).
const MIN_OPS_SECRET_LENGTH = 32;

/**
 * OPS_APP_URL needs an OPS_SECRET the demo app accepts, unless fakes are on. The secret alone
 * is checked only when the URL is set, since it may be there for docker compose. Runs even
 * when other fields fail.
 */
function opsSecretForApp() {
  const check = (config: Record<string, unknown> | undefined, ctx: z.RefinementCtx) => {
    // With fakes on, the daemon ignores OPS_APP_URL and uses in-memory ops.
    if (config?.USE_FAKE_ADAPTERS === true || config?.OPS_APP_URL === undefined) return;
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

// The demo app's Railway service, for the Tier 3 rollback tool. Set all of them or none.
const OPS_RAILWAY_KEYS = [
  'OPS_RAILWAY_TOKEN',
  'OPS_RAILWAY_PROJECT_ID',
  'OPS_RAILWAY_ENVIRONMENT_ID',
  'OPS_RAILWAY_SERVICE_ID',
] as const;

/** A Railway project, environment or service id, which are UUIDs. */
const railwayId = z.guid('must be a Railway id, which is a UUID');

/**
 * The OPS_RAILWAY_* vars come as a set, and with OPS_APP_URL: a rollback changes that app,
 * and a Tier 3 run claims the app by its URL. Skipped with fakes on, which deploy nothing.
 * Runs even when other fields fail.
 */
function railwayForApp() {
  const check = (config: Record<string, unknown> | undefined, ctx: z.RefinementCtx) => {
    if (config?.USE_FAKE_ADAPTERS === true) return;
    const set = OPS_RAILWAY_KEYS.filter((key) => config?.[key] !== undefined);
    if (set.length === 0) return;
    for (const key of OPS_RAILWAY_KEYS) {
      if (!set.includes(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required with ${set.join(', ')}`,
        });
      }
    }
    if (config?.OPS_APP_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPS_APP_URL'],
        message: 'OPS_APP_URL is required with OPS_RAILWAY_*: a rollback changes that app',
      });
    }
  };
  return [check, { when: () => true }] as const;
}

/**
 * AUTO_APPROVE_OPS skips the person who approves each gated ops call, so it is refused for
 * an app anyone else uses: only with fakes, or with OPS_APP_URL on this machine and no
 * Railway service, whose rollback would reach a shared deploy. Runs even when other fields
 * fail.
 */
function autoApproveOnlyHere() {
  const check = (config: Record<string, unknown> | undefined, ctx: z.RefinementCtx) => {
    if (config?.AUTO_APPROVE_OPS !== true || config.USE_FAKE_ADAPTERS === true) return;
    const raw = config.OPS_APP_URL;
    const local =
      typeof raw !== 'string' ||
      (URL.canParse(raw) && LOOPBACK_HOSTS.includes(new URL(raw).hostname));
    const railway = OPS_RAILWAY_KEYS.some((key) => config[key] !== undefined);
    if (local && !railway) return;
    ctx.addIssue({
      code: 'custom',
      path: ['AUTO_APPROVE_OPS'],
      message:
        'AUTO_APPROVE_OPS needs USE_FAKE_ADAPTERS, or an OPS_APP_URL on this machine and no OPS_RAILWAY_*: a person approves changes to a shared app',
    });
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
      // What the agents page calls this daemon. Sent in the socket handshake. Unset, the
      // daemon goes by its hostname, which on Railway changes with each deploy.
      NODE_NAME: nodeNameSchema.optional(),
      // Must match the orchestrator's, which creates the `fix` queue there.
      PGBOSS_SCHEMA: z
        .string()
        .regex(/^[a-z_][a-z0-9_]*$/)
        .default('pgboss'),
      // Built from infra/sandbox/Dockerfile.
      SANDBOX_IMAGE: z.string().min(1).default('page-sandbox'),
      // docker: one container per run (ADR 0001). local: one workspace in the daemon's own
      // container, run as an unprivileged user, for hosts without Docker such as Railway.
      SANDBOX_RUNTIME: z.enum(['docker', 'local']).default('docker'),
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
      OPS_APP_URL: opsAppUrl.optional(),
      // That app's OPS_SECRET. Also docker compose's, so it may be set without OPS_APP_URL.
      // Trimmed as the eval trims it, so a pasted space doesn't end up in the bearer token.
      OPS_SECRET: z.string().trim().min(1).optional(),
      // The Railway service that serves OPS_APP_URL, which Tier 3 runs may roll back. Unset,
      // they get no rollback tool. A project token, sent as Project-Access-Token, scoped to
      // one environment. Not RAILWAY_TOKEN or RAILWAY_*_ID: Railway sets those on every
      // service it runs, so on Railway the daemon would read its own service and roll itself
      // back, and the Railway CLI reads RAILWAY_TOKEN.
      OPS_RAILWAY_TOKEN: z.string().trim().min(1).optional(),
      OPS_RAILWAY_PROJECT_ID: railwayId.optional(),
      OPS_RAILWAY_ENVIRONMENT_ID: railwayId.optional(),
      OPS_RAILWAY_SERVICE_ID: railwayId.optional(),
      // Off: a person approves each gated ops call on the incident page. On, the daemon
      // approves them itself, which only fakes or an ops app on this machine may do.
      AUTO_APPROVE_OPS: z.stringbool().default(false),
    })
    .superRefine(
      ...requireUnlessFake([
        'OPENROUTER_API_KEY',
        'OPENROUTER_MODEL',
        'GITHUB_TOKEN',
        'GITHUB_REPO',
      ]),
    )
    .superRefine(...opsSecretForApp())
    .superRefine(...railwayForApp())
    .superRefine(...autoApproveOnlyHere()),
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
