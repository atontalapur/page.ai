import { z } from 'zod';

type Env = Record<string, string | undefined>;

// Apart from the shop settings so a seeded config bug can't switch error reporting off.
const schema = z.object({
  POSTHOG_KEY: z
    .string()
    .trim()
    .optional()
    .transform((key) => key || undefined),
  POSTHOG_HOST: z.url().default('https://us.i.posthog.com'),
  // Railway sets this on deploys. Locally there's no SHA, so errors carry "dev".
  RAILWAY_GIT_COMMIT_SHA: z.string().min(1).default('dev'),
});

export interface ReportingConfig {
  /** Unset in tests and local dev, which then use the fake reporter. */
  key: string | undefined;
  host: string;
  release: string;
}

export function loadReportingConfig(env: Env = process.env): ReportingConfig {
  const config = schema.parse(env);
  return {
    key: config.POSTHOG_KEY,
    host: config.POSTHOG_HOST,
    release: config.RAILWAY_GIT_COMMIT_SHA,
  };
}

/** Like `loadReportingConfig`, but a bad value turns reporting off instead of throwing. */
export function safeReportingConfig(env: Env = process.env): ReportingConfig {
  try {
    return loadReportingConfig(env);
  } catch (err) {
    console.error('Error reporting is off: bad POSTHOG_* config', err);
    return { key: undefined, host: '', release: 'dev' };
  }
}
