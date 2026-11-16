import { PostHog } from 'posthog-node';
import { safeReportingConfig } from './config.ts';

let client: PostHog | undefined;
let initialized = false;

function serverAnalytics(): PostHog | undefined {
  if (initialized) return client;
  initialized = true;

  const { key, host } = safeReportingConfig();
  if (!key || !host) {
    if (process.env.NODE_ENV !== 'production') {
      const missingVariable = key ? 'POSTHOG_HOST' : 'POSTHOG_KEY';
      console.warn(
        `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
      );
    }
    return undefined;
  }

  client = new PostHog(key, {
    host,
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 2000,
    fetchRetryCount: 0,
    enableExceptionAutocapture: true,
  });
  return client;
}

/** Captures a personless storefront outcome without allowing analytics failures to affect it. */
export async function captureServerEvent(
  event: string,
  properties: Record<string, number> = {},
): Promise<void> {
  const posthog = serverAnalytics();
  if (!posthog) return;

  try {
    posthog.capture({ event, properties });
    await posthog.flush().catch(() => undefined);
  } catch (err) {
    console.error('PostHog capture failed', err);
  }
}
