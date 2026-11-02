import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequestError } from './instrumentation.ts';
import { FakeErrorReporter } from './observability/reporter.ts';
import { resetServerReporter, serverReporter } from './observability/server.ts';

const request = { path: '/orders/7', method: 'GET', headers: {} };
const context = {
  routerKind: 'App Router',
  routePath: '/orders/[id]',
  routeType: 'render',
  renderSource: 'server-rendering',
  revalidateReason: undefined,
  renderType: 'dynamic',
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerReporter();
});

describe('onRequestError', () => {
  it('reports a server error with its route and digest', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('POSTHOG_KEY', '');
    const error = Object.assign(new TypeError('boom'), { digest: '42' });
    await onRequestError(error, request, context);
    const fake = serverReporter() as FakeErrorReporter;
    expect(fake.captured).toEqual([
      {
        error,
        properties: {
          error_name: 'TypeError',
          release: 'dev',
          route: '/orders/[id]',
          path: '/orders/7',
          method: 'GET',
          source: 'render',
          digest: '42',
        },
      },
    ]);
  });

  it('drops a digest that is not a string', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('POSTHOG_KEY', '');
    await onRequestError(Object.assign(new Error('x'), { digest: undefined }), request, context);
    const [captured] = (serverReporter() as FakeErrorReporter).captured;
    expect(captured?.properties).not.toHaveProperty('digest');
  });

  it('skips the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('POSTHOG_KEY', '');
    await onRequestError(new Error('x'), request, context);
    expect((serverReporter() as FakeErrorReporter).captured).toEqual([]);
  });
});
