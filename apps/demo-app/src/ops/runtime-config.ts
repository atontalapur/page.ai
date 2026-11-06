import {
  isShopSettingKey,
  loadShopSettings,
  SHOP_SETTING_KEYS,
  type Env,
  type ShopSettingKey,
  type ShopSettings,
} from '../config.ts';
import type { Queryable } from '../db/index.ts';

/** Rows of `runtime_config`: shop settings that override the env variable of the same name. */
export type RuntimeConfig = Partial<Record<ShopSettingKey, string>>;

/** Reads every override. A row for a key the code no longer knows is skipped. */
export async function readRuntimeConfig(db: Queryable): Promise<RuntimeConfig> {
  const { rows } = await db.query<{ key: string; value: string }>(
    'select key, value from runtime_config',
  );
  const config: RuntimeConfig = {};
  for (const { key, value } of rows) if (isShopSettingKey(key)) config[key] = value;
  return config;
}

export async function setRuntimeConfig(
  db: Queryable,
  key: ShopSettingKey,
  value: string,
): Promise<void> {
  await db.query(
    `insert into runtime_config (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

/** Deletes the override, so the env value (or the default) applies again. */
export async function unsetRuntimeConfig(db: Queryable, key: ShopSettingKey): Promise<void> {
  await db.query('delete from runtime_config where key = $1', [key]);
}

/** The env loadShopSettings reads: process env with the overrides laid over it. */
export function withRuntimeConfig(env: Env, config: RuntimeConfig): Env {
  return { ...env, ...config };
}

export type SettingsResult = { ok: true; settings: ShopSettings } | { ok: false; error: string };

/** loadShopSettings as a value, so a preview can show a bad result instead of throwing. */
export function trySettings(env: Env): SettingsResult {
  try {
    return { ok: true, settings: loadShopSettings(env) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SettingSource {
  key: ShopSettingKey;
  /** The process env value, or null when unset. */
  env: string | null;
  /** The runtime config row, or null when there is none. */
  override: string | null;
}

/** Where each setting comes from, in SHOP_SETTING_KEYS order. */
export function settingSources(env: Env, config: RuntimeConfig): SettingSource[] {
  return SHOP_SETTING_KEYS.map((key) => ({
    key,
    env: env[key] ?? null,
    override: config[key] ?? null,
  }));
}
