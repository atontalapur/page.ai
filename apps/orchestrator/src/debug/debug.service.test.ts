import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DebugTools } from '../config.ts';
import { testConfig } from '../db/test-utils.ts';
import { createLogger } from '../logger.ts';
import { DebugService, DebugToolsOff } from './debug.service.ts';

const APP = 'https://demo.example.com';
const SECRET = 's'.repeat(32);
const debug: DebugTools = {
  demoAppUrl: APP,
  opsSecret: SECRET,
  posthog: { key: 'phc_test', host: 'https://ph.example.com' },
};

/** A demo app: its catalogue, its overrides, and how the product and order routes answer. */
function fakeApp(
  app: { productStatus?: number; orderStatus?: number; overrides?: Record<string, string> } = {},
) {
  const overrides = { ...app.overrides };
  const calls: string[] = [];
  const fetchMock = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const authed =
      (init.headers as Record<string, string> | undefined)?.authorization === `Bearer ${SECRET}`;
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      Promise.resolve(Response.json(body, { status, headers }));
    if (url.host === 'ph.example.com') return json({ status: 1 });
    if (url.pathname === '/api/health') return json({ ok: true });
    if (url.pathname === '/api/products') return json([{ id: 7, slug: 'field-notebook' }]);
    if (url.pathname.startsWith('/api/products/')) return json({}, app.productStatus ?? 200);
    if (url.pathname === '/api/cart/items')
      return json({}, 201, { 'set-cookie': 'cart=abc; Path=/' });
    if (url.pathname === '/api/orders') {
      expect((init.headers as Record<string, string>).cookie).toBe('cart=abc');
      return json({}, app.orderStatus ?? 500);
    }
    if (!authed) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/api/ops/config') {
      return json({
        settings: [
          {
            key: 'SHIPPING_FLAT_CENTS',
            env: null,
            override: overrides.SHIPPING_FLAT_CENTS ?? null,
          },
          { key: 'CHECKOUT_ENABLED', env: 'true', override: overrides.CHECKOUT_ENABLED ?? null },
        ],
      });
    }
    const key = url.pathname.split('/').pop()!;
    if (method === 'PUT') {
      overrides[key] = (JSON.parse(String(init.body)) as { value: string }).value;
      return json({});
    }
    if (method === 'DELETE') {
      delete overrides[key];
      return json({});
    }
    if (url.pathname === '/api/ops/restart') return json({}, 202);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, overrides, fetchMock };
}

/** Off when `tools` is null. */
function service(tools: DebugTools | null = debug) {
  const s = new DebugService({ ...testConfig, debug: tools ?? undefined }, createLogger('fatal'));
  s.sleep = () => Promise.resolve();
  return s;
}

afterEach(() => vi.unstubAllGlobals());

describe('DebugService', () => {
  it('breaks checkout: sets the override, restarts, and sees the order fail with 500', async () => {
    const app = fakeApp();
    const result = await service().create('checkout');

    expect(result).toMatchObject({ ok: true, status: 500 });
    expect(app.overrides).toEqual({ SHIPPING_FLAT_CENTS: '2500000000' });
    expect(app.calls).toEqual([
      'PUT /api/ops/config/SHIPPING_FLAT_CENTS',
      'POST /api/ops/restart',
      'GET /api/health',
      'GET /api/products',
      'POST /api/cart/items',
      'POST /api/orders',
    ]);
  });

  it('says so when the broken checkout did not fail', async () => {
    fakeApp({ orderStatus: 201 });
    expect(await service().create('checkout')).toMatchObject({ ok: false, status: 201 });
  });

  it('reports the code bug only when the product route fails', async () => {
    fakeApp({ productStatus: 500 });
    expect(await service().create('code_bug')).toMatchObject({ ok: true, status: 500 });
    fakeApp({ productStatus: 200 });
    expect(await service().create('code_bug')).toMatchObject({ ok: false, status: 200 });
  });

  it('sends a synthetic exception to PostHog with the project key, once per click', async () => {
    const app = fakeApp();
    expect(await service().create('synthetic')).toMatchObject({ ok: true });
    const [, init] = app.fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { api_key: string; event: string };
    expect(body).toMatchObject({ api_key: 'phc_test', event: '$exception' });
    expect(await service({ ...debug, posthog: undefined }).create('synthetic')).toMatchObject({
      ok: false,
    });
  });

  it('resets by clearing every override and restarting', async () => {
    const app = fakeApp({
      overrides: { SHIPPING_FLAT_CENTS: '2500000000', CHECKOUT_ENABLED: 'false' },
    });
    const result = await service().reset();
    expect(app.overrides).toEqual({});
    expect(result.message).toBe(
      'Cleared SHIPPING_FLAT_CENTS, CHECKOUT_ENABLED and restarted the demo app.',
    );
  });

  it("shows the app's health, its overrides and whether a code bug is live", async () => {
    fakeApp({ productStatus: 500, overrides: { SHIPPING_FLAT_CENTS: '2500000000' } });
    expect(await service().state()).toEqual({
      demoAppUrl: APP,
      healthy: true,
      overrides: [{ key: 'SHIPPING_FLAT_CENTS', value: '2500000000' }],
      codeBugLive: true,
      canSendSynthetic: true,
    });
  });

  it('refuses everything when the tools are off', async () => {
    await expect(service(null).state()).rejects.toBeInstanceOf(DebugToolsOff);
    await expect(service(null).create('checkout')).rejects.toBeInstanceOf(DebugToolsOff);
  });
});
