import type { Instrumentation } from 'next';

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
