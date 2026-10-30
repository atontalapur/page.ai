import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { loadShopSettings, type ShopSettings } from '../config.ts';
import { getDb, type Db } from '../db/index.ts';

export type CookieStore = Pick<Awaited<ReturnType<typeof cookies>>, 'get' | 'set'>;

export interface ShopContext {
  db: Db;
  settings: ShopSettings;
  cookies: CookieStore;
}

// Env doesn't change while the process runs. A parse failure isn't cached, so a bad
// setting keeps failing shop requests until it's fixed and the app restarts.
let settings: ShopSettings | undefined;

/**
 * Per-request dependencies for pages, actions and route handlers. `connection()` keeps
 * database reads out of build-time prerendering, so `next build` needs no database.
 */
export async function shop(): Promise<ShopContext> {
  await connection();
  settings ??= loadShopSettings();
  return { db: getDb(), settings, cookies: await cookies() };
}
