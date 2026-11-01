import { z } from 'zod';

type Env = Record<string, string | undefined>;

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
});

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  pgbossSchema: string;
}

export function loadConfig(env: Env = process.env): Config {
  const config = schema.parse(env);
  return {
    databaseUrl: config.DATABASE_URL,
    port: config.PORT,
    host: config.HOST,
    pgbossSchema: config.PGBOSS_SCHEMA,
  };
}
