import { PostHog } from 'posthog-node';
import { safeReportingConfig, type ReportingConfig } from './config.ts';
import {
  errorProperties,
  FakeErrorReporter,
  type ErrorContext,
  type ErrorReporter,
} from './reporter.ts';

/** The part of posthog-node the reporter uses, so tests can pass a fake client. */
export interface PostHogServerClient {
  captureExceptionImmediate(
    error: unknown,
    distinctId?: string,
    properties?: Record<string, string>,
  ): Promise<void>;
}

export class PostHogErrorReporter implements ErrorReporter {
  private readonly client: PostHogServerClient;
  private readonly release: string;

  constructor(client: PostHogServerClient, release: string) {
    this.client = client;
    this.release = release;
  }

  async captureException(error: unknown, context: ErrorContext): Promise<void> {
    try {
      // Immediate, not batched: a staging error should reach PostHog within the minute
      // even if the process is replaced right after. No distinct id: server errors have
      // no user, and posthog-node then sends a person-less event.
      await this.client.captureExceptionImmediate(
        error,
        undefined,
        errorProperties(error, context, this.release),
      );
    } catch (err) {
      console.error('PostHog capture failed', err);
    }
  }
}

export function createServerReporter(config: ReportingConfig): ErrorReporter {
  if (!config.key) return new FakeErrorReporter(config.release);
  return new PostHogErrorReporter(new PostHog(config.key, { host: config.host }), config.release);
}

let reporter: ErrorReporter | undefined;

/** One reporter per server process, built from env on first use. */
export function serverReporter(): ErrorReporter {
  reporter ??= createServerReporter(safeReportingConfig());
  return reporter;
}

/** Tests only: drop the cached reporter so the next call re-reads env. */
export function resetServerReporter(): void {
  reporter = undefined;
}
