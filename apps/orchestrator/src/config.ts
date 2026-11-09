import { baseConfigSchema } from '@page/contracts';
import { z } from 'zod';

type Env = Record<string, string | undefined>;

// A copied .env.example leaves vars blank; treat that as unset, like the node daemon does.
const blankAsUnset = <T extends z.ZodType>(inner: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    inner,
  );

export type LogLevel = z.infer<typeof baseConfigSchema.shape.LOG_LEVEL>;

const schema = z.object({
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
  USE_FAKE_ADAPTERS: blankAsUnset(baseConfigSchema.shape.USE_FAKE_ADAPTERS),
  LOG_LEVEL: blankAsUnset(baseConfigSchema.shape.LOG_LEVEL),
});

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  pgbossSchema: string;
  useFakeAdapters: boolean;
  logLevel: LogLevel;
}

/** A bad or missing env var. The message names every one, so main prints it alone. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

function describeIssue(issue: z.core.$ZodIssue, env: Env): string {
  const key = issue.path.join('.');
  return env[key] === undefined ? `${key} is required` : `${key}: ${issue.message}`;
}

export function loadConfig(env: Env = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => describeIssue(issue, env));
    throw new ConfigError(`invalid config: ${problems.join('; ')}`);
  }
  const config = parsed.data;
  return {
    databaseUrl: config.DATABASE_URL,
    port: config.PORT,
    host: config.HOST,
    pgbossSchema: config.PGBOSS_SCHEMA,
    useFakeAdapters: config.USE_FAKE_ADAPTERS,
    logLevel: config.LOG_LEVEL,
  };
}
