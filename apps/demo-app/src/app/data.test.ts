import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/index.ts';
import { createTestDb } from '../db/test-utils.ts';
import { setRuntimeConfig } from '../ops/runtime-config.ts';
import { loadedSettings, shop } from './data.ts';

const jar = { get: vi.fn(), set: vi.fn() };
const h = vi.hoisted(() => ({ db: undefined as unknown as Db }));
vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar) }));
vi.mock('../db/index.ts', () => ({ getDb: () => h.db }));

describe('shop', () => {
  beforeEach(async () => {
    delete (globalThis as { demoAppShop?: unknown }).demoAppShop;
    h.db = await createTestDb();
    return () => vi.unstubAllEnvs();
  });

  it('builds the request context from env and the request cookies', async () => {
    vi.stubEnv('CHECKOUT_ENABLED', 'false');
    expect(loadedSettings()).toBeUndefined();
    const ctx = await shop();
    expect(ctx.settings.checkoutEnabled).toBe(false);
    expect(ctx.cookies).toBe(jar);
    expect(ctx.db).toBe(h.db);
    expect(loadedSettings()).toBe(ctx.settings);

    // Parsed once per process: a later env change doesn't leak into requests.
    vi.stubEnv('CHECKOUT_ENABLED', 'true');
    expect((await shop()).settings).toBe(ctx.settings);
  });

  it('lets runtime config override env, read once per process', async () => {
    vi.stubEnv('MAX_ITEM_QUANTITY', '0');
    await setRuntimeConfig(h.db, 'MAX_ITEM_QUANTITY', '4');
    expect((await shop()).settings.maxItemQuantity).toBe(4);

    // A change waits for a restart.
    await setRuntimeConfig(h.db, 'MAX_ITEM_QUANTITY', '6');
    expect((await shop()).settings.maxItemQuantity).toBe(4);
  });

  it('keeps failing on a bad setting until a restart, even after a fix', async () => {
    vi.stubEnv('MAX_ITEM_QUANTITY', '0');
    await expect(shop()).rejects.toThrow();
    await setRuntimeConfig(h.db, 'MAX_ITEM_QUANTITY', '4');
    await expect(shop()).rejects.toThrow();

    delete (globalThis as { demoAppShop?: unknown }).demoAppShop;
    expect((await shop()).settings.maxItemQuantity).toBe(4);
  });
});
