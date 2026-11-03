import { z } from 'zod';
import type { Env } from '../config.ts';

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

/**
 * The browser config, for next.config.ts to inline at build time. Browser code can't read
 * runtime env, so the Docker build needs POSTHOG_* and RAILWAY_GIT_COMMIT_SHA as build args.
 */
export function browserReportingEnv(env: Env = process.env): Record<string, string> {
  const config = safeReportingConfig(env);
  return {
    NEXT_PUBLIC_POSTHOG_KEY: config.key ?? '',
    NEXT_PUBLIC_POSTHOG_HOST: config.host,
    NEXT_PUBLIC_RELEASE: config.release,
  };
}
