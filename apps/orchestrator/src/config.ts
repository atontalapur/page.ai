import { baseConfigSchema, envSchema } from '@page/contracts';
import { z } from 'zod';

type Env = Record<string, string | undefined>;

export type LogLevel = z.infer<typeof baseConfigSchema.shape.LOG_LEVEL>;

/** NOTIFY_TO_NUMBERS: comma-separated, blanks dropped. */
export function splitNumbers(list = ''): string[] {
  return list
    .split(',')
    .map((number) => number.trim())
    .filter((number) => number.length > 0);
}

// The pager's settings. scripts/test-page.ts reads them through loadPagerConfig, so the
// test and the orchestrator parse them the same way.
const pagerShape = {
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM_NUMBER: z.string().min(1).optional(),
  NOTIFY_TO_NUMBERS: z.string().optional().transform(splitNumbers),
  // Twilio answering machine detection, so a call voicemail picks up is retried. Off by
  // default: a trial account rejects the parameter, failing every call (docs/twilio.md).
  TWILIO_MACHINE_DETECTION: z.stringbool().default(false),
};
const pagerSchema = envSchema(z.object(pagerShape));

// envSchema drops blank vars first, as the node daemon's does, so a copied .env.example
// behaves like an unset var.
const schema = envSchema(
  z.object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // Railway injects PORT. 4000 locally, so the demo app keeps 3000.
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().min(1).default('0.0.0.0'),
    // pg-boss keeps its tables in their own schema, apart from the issue tables.
    PGBOSS_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .default('pgboss'),
    // The node daemon's parser (true/1/yes/on, false/0/no/off).
    USE_FAKE_ADAPTERS: baseConfigSchema.shape.USE_FAKE_ADAPTERS,
    LOG_LEVEL: baseConfigSchema.shape.LOG_LEVEL,
    // Blank is unset. The webhook then rejects every request.
    POSTHOG_WEBHOOK_SECRET: z.string().min(1).optional(),
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    TRIAGE_MODEL: z.string().min(1).default('openai/gpt-4o-mini'),
    TRIAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
    ...pagerShape,
    DASHBOARD_URL: z.string().min(1).default('http://localhost:3000'),
  }),
);

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
  from: string;
  /** Answering machine detection: voicemail counts as not answered. */
  machineDetection: boolean;
}

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  pgbossSchema: string;
  useFakeAdapters: boolean;
  logLevel: LogLevel;
  posthogWebhookSecret: string | undefined;
  openRouterApiKey: string | undefined;
  triageModel: string;
  triageTimeoutMs: number;
  /** Set only when all three Twilio vars are present. */
  twilio: TwilioCreds | undefined;
  notifyTo: string[];
  dashboardUrl: string;
}

/** A bad or missing env var. The message names every one, so main prints it alone. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

function describeIssue(issue: z.core.$ZodIssue, env: Env): string {
  const key = issue.path.join('.');
  if (key === '') return issue.message;
  // A blank var was dropped before parsing, so it's as missing as an unset one.
  return env[key]?.trim() ? `${key}: ${issue.message}` : `${key} is required`;
}

function parseEnv<T>(schema: z.ZodType<T>, env: Env): T {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => describeIssue(issue, env));
    throw new ConfigError(`invalid config: ${problems.join('; ')}`);
  }
  return parsed.data;
}

export type PagerConfig = Pick<Config, 'twilio' | 'notifyTo'>;

function pagerConfig(config: z.infer<typeof pagerSchema>): PagerConfig {
  const sid = config.TWILIO_ACCOUNT_SID;
  const token = config.TWILIO_AUTH_TOKEN;
  const from = config.TWILIO_FROM_NUMBER;
  const twilioParts = [sid, token, from].filter((part) => part !== undefined);
  if (twilioParts.length > 0 && twilioParts.length < 3) {
    throw new ConfigError(
      'invalid config: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are set together',
    );
  }
  return {
    twilio:
      sid && token && from
        ? {
            accountSid: sid,
            authToken: token,
            from,
            machineDetection: config.TWILIO_MACHINE_DETECTION,
          }
        : undefined,
    notifyTo: config.NOTIFY_TO_NUMBERS,
  };
}

/** The Twilio settings and numbers alone, for a script that pages without the app. */
export function loadPagerConfig(env: Env = process.env): PagerConfig {
  return pagerConfig(parseEnv(pagerSchema, env));
}

export function loadConfig(env: Env = process.env): Config {
  const config = parseEnv(schema, env);
  return {
    ...pagerConfig(config),
    databaseUrl: config.DATABASE_URL,
    port: config.PORT,
    host: config.HOST,
    pgbossSchema: config.PGBOSS_SCHEMA,
    useFakeAdapters: config.USE_FAKE_ADAPTERS,
    logLevel: config.LOG_LEVEL,
    posthogWebhookSecret: config.POSTHOG_WEBHOOK_SECRET,
    openRouterApiKey: config.OPENROUTER_API_KEY,
    triageModel: config.TRIAGE_MODEL,
    triageTimeoutMs: config.TRIAGE_TIMEOUT_MS,
    dashboardUrl: config.DASHBOARD_URL,
  };
}
