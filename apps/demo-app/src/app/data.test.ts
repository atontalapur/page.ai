import { describe, expect, it, vi } from 'vitest';
import { shop } from './data.ts';

const jar = { get: vi.fn(), set: vi.fn() };
vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar) }));

describe('shop', () => {
  it('builds the request context from env and the request cookies', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://page:page@localhost:5432/demo');
    vi.stubEnv('CHECKOUT_ENABLED', 'false');
    const ctx = await shop();
    expect(ctx.settings.checkoutEnabled).toBe(false);
    expect(ctx.cookies).toBe(jar);
    expect(typeof ctx.db.query).toBe('function');
    vi.unstubAllEnvs();
  });
});
