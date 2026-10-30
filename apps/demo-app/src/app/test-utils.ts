import type { ShopSettings } from '../config.ts';
import { seededDb, settings } from '../shop/test-utils.ts';
import type { CookieStore, ShopContext } from './data.ts';

export interface TestShop extends ShopContext {
  jar: Map<string, string>;
}

/** A seeded in-memory shop with a cookie jar, standing in for `shop()` in tests. */
export async function testShop(overrides: Partial<ShopSettings> = {}): Promise<TestShop> {
  const jar = new Map<string, string>();
  const cookies = {
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
  } as unknown as CookieStore;
  return { db: await seededDb(), settings: { ...settings, ...overrides }, cookies, jar };
}

/** Awaits a call that should end in `redirect()` or `notFound()` and returns where it went. */
export async function navigation(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    const digest = (err as { digest?: string }).digest ?? '';
    if (digest.startsWith('NEXT_REDIRECT')) return digest.split(';')[2] ?? '';
    if (digest === 'NEXT_HTTP_ERROR_FALLBACK;404') return 'not-found';
    throw err;
  }
  throw new Error('expected a redirect or notFound');
}
