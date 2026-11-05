import { z } from 'zod';
import {
  checkShopSetting,
  isShopSettingKey,
  SHOP_SETTING_KEYS,
  type Env,
  type ShopSettingKey,
  type ShopSettings,
} from '../config.ts';
import type { Queryable } from '../db/index.ts';
import { checkOpsAuth, opsError, readDryRun } from './auth.ts';
import type { Restarter } from './restart.ts';
import {
  readRuntimeConfig,
  setRuntimeConfig,
  settingSources,
  trySettings,
  unsetRuntimeConfig,
  withRuntimeConfig,
  type RuntimeConfig,
  type SettingsResult,
} from './runtime-config.ts';

export interface OpsDeps {
  db: Queryable;
  env: Env;
  /** The settings this process serves with; undefined before the first shop request. */
  loaded: ShopSettings | undefined;
  restarter: Restarter;
}

const setBody = z.strictObject({ value: z.string() });

// Every ops call checks the secret first, so an unauthenticated caller learns nothing,
// not even which keys exist.
async function guarded(
  request: Request,
  deps: OpsDeps,
  work: (dryRun: boolean) => Promise<Response>,
): Promise<Response> {
  const denied = checkOpsAuth(request, deps.env);
  if (denied) return denied;
  const dryRun = readDryRun(request);
  return dryRun instanceof Response ? dryRun : work(dryRun);
}

function afterRestart(deps: OpsDeps, config: RuntimeConfig): SettingsResult {
  return trySettings(withRuntimeConfig(deps.env, config));
}

function unknownKey(key: string): Response {
  return opsError(
    404,
    'unknown_key',
    `${key} is not a shop setting: ${SHOP_SETTING_KEYS.join(', ')}`,
  );
}

/** Settings fields whose value differs between what is served now and after a restart. */
function changedFields(now: ShopSettings | undefined, next: SettingsResult): string[] {
  if (!now || !next.ok) return [];
  return (Object.keys(now) as (keyof ShopSettings)[]).filter((f) => now[f] !== next.settings[f]);
}

/** GET /api/ops/config: where each setting comes from, and what a restart would serve. */
export function getConfig(request: Request, deps: OpsDeps): Promise<Response> {
  return guarded(request, deps, async () => {
    const config = await readRuntimeConfig(deps.db);
    return Response.json({
      settings: settingSources(deps.env, config),
      current: deps.loaded ?? null,
      afterRestart: afterRestart(deps, config),
    });
  });
}

/**
 * Sets (`value` a string) or clears (`value` null) one override and returns the preview:
 * the row before and after, and the settings a restart would load with it.
 */
async function changeConfig(
  deps: OpsDeps,
  dryRun: boolean,
  key: ShopSettingKey,
  value: string | null,
): Promise<Response> {
  const config = await readRuntimeConfig(deps.db);
  const next: RuntimeConfig = { ...config };
  if (value === null) delete next[key];
  else next[key] = value;

  if (!dryRun) {
    if (value === null) await unsetRuntimeConfig(deps.db, key);
    else await setRuntimeConfig(deps.db, key, value);
  }
  return Response.json({
    dryRun,
    key,
    env: deps.env[key] ?? null,
    from: config[key] ?? null,
    to: value,
    appliesOn: 'restart',
    afterRestart: afterRestart(deps, next),
  });
}

/** PUT /api/ops/config/:key with `{ "value": "..." }`. Rejects a value the shop can't read. */
export function putConfig(request: Request, key: string, deps: OpsDeps): Promise<Response> {
  return guarded(request, deps, async (dryRun) => {
    if (!isShopSettingKey(key)) return unknownKey(key);
    const parsed = setBody.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return opsError(400, 'bad_request', 'Expected { "value": string }');
    const problem = checkShopSetting(key, parsed.data.value);
    if (problem) return opsError(400, 'invalid_value', `${key}: ${problem}`);
    return changeConfig(deps, dryRun, key, parsed.data.value);
  });
}

/** DELETE /api/ops/config/:key: drops the override, so the env value applies again. */
export function deleteConfig(request: Request, key: string, deps: OpsDeps): Promise<Response> {
  return guarded(request, deps, async (dryRun) => {
    if (!isShopSettingKey(key)) return unknownKey(key);
    return changeConfig(deps, dryRun, key, null);
  });
}

/**
 * POST /api/ops/restart: 202, then the process exits non-zero and the platform starts it
 * again. The preview shows which settings the restart would change.
 */
export function postRestart(request: Request, deps: OpsDeps): Promise<Response> {
  return guarded(request, deps, async (dryRun) => {
    const next = afterRestart(deps, await readRuntimeConfig(deps.db));
    const preview = {
      dryRun,
      current: deps.loaded ?? null,
      afterRestart: next,
      changed: changedFields(deps.loaded, next),
    };
    if (dryRun) return Response.json(preview);
    deps.restarter.schedule();
    return Response.json({ ...preview, restarting: true }, { status: 202 });
  });
}
