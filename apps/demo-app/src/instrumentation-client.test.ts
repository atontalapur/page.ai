import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeErrorReporter } from './observability/reporter.ts';

// Fresh modules per test, since the file runs its setup once on import. No POSTHOG key is
// inlined under vitest, so the client keeps the fake reporter.
async function loadWithDocumentId(id: string) {
  vi.stubGlobal('document', { documentElement: { id } });
  vi.resetModules();
  return import('./instrumentation-client.ts');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('instrumentation-client', () => {
  it('skips the browser repeat of a failed server render until the next navigation', async () => {
    const { onRouterTransitionStart } = await loadWithDocumentId('__next_error__');
    const client = await import('./observability/client.ts');
    expect(client.reportBoundaryError(new Error('render'))).toBe(false);
    onRouterTransitionStart();
    expect(client.reportBoundaryError(new Error('render'))).toBe(true);
    expect((client.clientReporter() as FakeErrorReporter).captured).toHaveLength(1);
  });

  it('reports boundary errors on a page that rendered on the server', async () => {
    await loadWithDocumentId('');
    const client = await import('./observability/client.ts');
    expect(client.reportBoundaryError(new Error('render'))).toBe(true);
  });
});
