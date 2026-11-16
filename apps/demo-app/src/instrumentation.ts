import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import type { Instrumentation } from 'next';
import { safeReportingConfig } from './observability/config.ts';

const reportingConfig = safeReportingConfig();

/** Exports only purpose-written storefront outcome logs added by this integration. */
export const posthogLogProvider = reportingConfig.key && reportingConfig.host
  ? new LoggerProvider({
      resource: resourceFromAttributes({
        'service.name': 'page-demo-app',
        'service.version': reportingConfig.release,
      }),
      processors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({
            url: new URL('/i/v1/logs', reportingConfig.host).toString(),
            headers: {
              Authorization: `Bearer ${reportingConfig.key}`,
              'Content-Type': 'application/json',
            },
          }),
        }),
      ],
    })
  : undefined;

if ((!reportingConfig.key || !reportingConfig.host) && process.env.NODE_ENV !== 'production') {
  const missingVariable = reportingConfig.key ? 'POSTHOG_HOST' : 'POSTHOG_KEY';
  console.warn(
    `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
  );
}

export function register() {
  // The dedicated logger is taken from this provider directly, so it works across OTel versions.
}

/**
 * Reports every unhandled server error (pages, route handlers, server actions) so a
 * seeded bug fired on staging lands in PostHog Error Tracking. `handle()` and `orShowError`
 * turn a ShopError into a 4xx before it gets here. One that escapes them is a 500, so it is
 * reported like any other crash.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  // posthog-node needs Node. The demo app has no edge routes, but proxy could be one.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { serverReporter } = await import('./observability/server.ts');
  const digest =
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof error.digest === 'string'
      ? error.digest
      : undefined;
  await serverReporter().captureException(error, {
    route: context.routePath,
    path: request.path,
    method: request.method,
    source: context.routeType,
    digest,
  });
};
