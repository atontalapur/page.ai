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

/**
 * Starts posthog-js with exception autocapture (window errors and unhandled rejections).
 * Does nothing without a key, so local dev and tests keep the fake.
 */
export function initClientReporting(
  config: ReportingConfig,
  client: PostHogBrowserClient = posthog,
): void {
  if (!config.key) return;
  client.init(config.key, {
    api_host: config.host,
    capture_exceptions: true,
    // Error tracking only. The demo app doesn't need analytics or recordings.
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
  });
  client.register({ release: config.release });
  reporter = {
    captureException(error: unknown, context: ErrorContext) {
      try {
        client.captureException(error, errorProperties(error, context, config.release));
      } catch (err) {
        console.error('PostHog capture failed', err);
      }
      return Promise.resolve();
    },
  };
}

export function clientReporter(): ErrorReporter {
  return reporter;
}

/**
 * Reports an error an error boundary caught. A server error arrives with a digest and was
 * already reported by `onRequestError`, so only browser errors are captured. Returns
 * whether it reported.
 */
export function reportBoundaryError(error: unknown): boolean {
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error ? error.digest : undefined;
  if (digest !== undefined) return false;
  void reporter.captureException(error, { source: 'client' });
  return true;
}

/** Tests only. */
export function resetClientReporting(): void {
  reporter = new FakeErrorReporter();
}
