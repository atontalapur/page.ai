import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { loadShopSettings, type ShopSettings } from '../config.ts';
import { getDb, type Db } from '../db/index.ts';
import { readRuntimeConfig, withRuntimeConfig, type RuntimeConfig } from '../ops/runtime-config.ts';

export type CookieStore = Pick<Awaited<ReturnType<typeof cookies>>, 'get' | 'set'>;

export interface ShopContext {
  db: Db;
  settings: ShopSettings;
  cookies: CookieStore;
}

// Env and runtime config are read once per process, so a config change applies on
// restart (#13). A parse failure isn't cached, but the runtime config it read is, so a
// bad setting keeps failing shop requests until it's fixed and the app restarts.
// Kept on globalThis: Next can load this module once per route bundle, and each copy
// reading the table on its own first request would apply a change to some routes early.
interface Loaded {
  runtimeConfig?: RuntimeConfig;
  settings?: ShopSettings;
}
const cache = globalThis as { demoAppShop?: Loaded };

/** The settings this process serves with, or undefined before the first shop request. */
export function loadedSettings(): ShopSettings | undefined {
  return cache.demoAppShop?.settings;
}

/**
 * Per-request dependencies for pages, actions and route handlers. `connection()` keeps
 * database reads out of build-time prerendering, so `next build` needs no database.
 */
export async function shop(): Promise<ShopContext> {
  await connection();
  const db = getDb();
  const loaded = (cache.demoAppShop ??= {});
  loaded.runtimeConfig ??= await readRuntimeConfig(db);
  loaded.settings ??= loadShopSettings(withRuntimeConfig(process.env, loaded.runtimeConfig));
  return { db, settings: loaded.settings, cookies: await cookies() };
}
