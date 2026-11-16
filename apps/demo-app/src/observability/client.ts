import posthog from 'posthog-js';
import type { ReportingConfig } from './config.ts';
import {
  errorProperties,
  FakeErrorReporter,
  type ErrorContext,
  type ErrorReporter,
} from './reporter.ts';

/** The part of posthog-js the reporter uses, so tests can pass a fake. */
export interface PostHogBrowserClient {
  init(key: string, options: Record<string, unknown>): unknown;
  register(properties: Record<string, string>): void;
  captureException(error: unknown, properties?: Record<string, string>): unknown;
}

let reporter: ErrorReporter = new FakeErrorReporter();
let serverRenderFailed = false;

/** Configures error reporting after the browser client has been initialized. */
export function configureClientReporting(
  config: ReportingConfig,
  client: PostHogBrowserClient = posthog,
): void {
  if (!config.key) return;
  // A super property, so autocaptured window errors carry the release too.
  client.register({ release: config.release });
  reporter = {
    captureException(error: unknown, context: ErrorContext) {
      try {
        client.captureException(error, errorProperties(error, context));
      } catch (err) {
        console.error('PostHog capture failed', err);
      }
      return Promise.resolve();
    },
  };
}

/**
 * Starts posthog-js for callers that do not use instrumentation-client.ts directly.
 * Does nothing without a key, so local dev and tests keep the fake.
 */
export function initClientReporting(
  config: ReportingConfig,
  client: PostHogBrowserClient = posthog,
): void {
  if (!config.key) return;
  client.init(config.key, {
    api_host: config.host,
    defaults: '2026-08-30',
    capture_exceptions: true,
  });
  configureClientReporting(config, client);
}

export function clientReporter(): ErrorReporter {
  return reporter;
}

/**
 * Set while the page is the client-side fallback for a failed server render. A component
 * that threw there throws again in the browser, and `onRequestError` already reported it.
 */
export function setServerRenderFailed(failed: boolean): void {
  serverRenderFailed = failed;
}

/**
 * Reports an error an error boundary caught. A server error arrives with a digest and was
 * already reported by `onRequestError`, as was a client component error that also failed
 * the server render, so only browser-only errors are captured. Returns whether it reported.
 */
export function reportBoundaryError(error: unknown): boolean {
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error ? error.digest : undefined;
  if (digest !== undefined || serverRenderFailed) return false;
  void reporter.captureException(error, { source: 'client' });
  return true;
}

/** Tests only. */
export function resetClientReporting(): void {
  reporter = new FakeErrorReporter();
  serverRenderFailed = false;
}
