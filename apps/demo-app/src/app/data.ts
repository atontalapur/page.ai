import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { loadConfig, shopSettings, type ShopSettings } from '../config.ts';
import { getDb, type Db } from '../db/index.ts';

export type CookieStore = Pick<Awaited<ReturnType<typeof cookies>>, 'get' | 'set'>;

export interface ShopContext {
  db: Db;
  settings: ShopSettings;
  cookies: CookieStore;
}

/**
 * Per-request dependencies for pages, actions and route handlers. `connection()` keeps
 * database reads out of build-time prerendering, so `next build` needs no database.
 */
export async function shop(): Promise<ShopContext> {
  await connection();
  return { db: getDb(), settings: shopSettings(loadConfig()), cookies: await cookies() };
}
