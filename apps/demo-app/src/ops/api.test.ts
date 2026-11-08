import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config.ts';
import { createTestDb } from '../db/test-utils.ts';
import { settings } from '../shop/test-utils.ts';
import { deleteConfig, getConfig, postRestart, putConfig, type OpsDeps } from './api.ts';
import { readRuntimeConfig, setRuntimeConfig } from './runtime-config.ts';

const SECRET = 's'.repeat(32);

async function setup(overrides: Partial<OpsDeps> = {}) {
  const restarter = { schedule: vi.fn() };
  const deps: OpsDeps = {
    db: await createTestDb(),
    env: { OPS_SECRET: SECRET },
    loaded: settings,
    restarter,
    ...overrides,
  };
  return { deps, restarter };
}

function call(method: string, path: string, body?: unknown, secret = SECRET): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('ops auth', () => {
  it('turns the API off when OPS_SECRET is unset or too short', async () => {
    for (const env of [{}, { OPS_SECRET: 'short' }] satisfies Env[]) {
      const { deps } = await setup({ env });
      const res = await getConfig(call('GET', '/api/ops/config'), deps);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'ops_disabled' });
    }
  });

  it('rejects a missing or wrong secret before looking at the request', async () => {
    const { deps, restarter } = await setup();
    const noHeader = new Request('http://localhost/api/ops/restart', { method: 'POST' });
    expect((await postRestart(noHeader, deps)).status).toBe(401);
    const wrong = call('PUT', '/api/ops/config/NOPE', { value: '1' }, 'x'.repeat(32));
    expect((await putConfig(wrong, 'NOPE', deps)).status).toBe(401);
    expect(restarter.schedule).not.toHaveBeenCalled();
  });

  it('rejects a misspelt or malformed dry run instead of running for real', async () => {
    const { deps } = await setup();
    for (const query of ['dryrun=true', 'dryRun=yes', 'dryRun=true&dryRun=false']) {
      const res = await putConfig(
        call('PUT', `/api/ops/config/MAX_ITEM_QUANTITY?${query}`, { value: '3' }),
        'MAX_ITEM_QUANTITY',
        deps,
      );
      expect(res.status).toBe(400);
    }
    expect(await readRuntimeConfig(deps.db)).toEqual({});
  });
});

describe('PUT /api/ops/config/:key', () => {
  const put = (deps: OpsDeps, key: string, body: unknown, query = '') =>
    putConfig(call('PUT', `/api/ops/config/${key}${query}`, body), key, deps);

  it('previews a change without writing it', async () => {
    const { deps } = await setup({ env: { OPS_SECRET: SECRET, MAX_ITEM_QUANTITY: '0' } });
    const res = await put(deps, 'MAX_ITEM_QUANTITY', { value: '5' }, '?dryRun=true');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dryRun: true,
      key: 'MAX_ITEM_QUANTITY',
      env: '0',
      from: null,
      to: '5',
      appliesOn: 'restart',
      afterRestart: { ok: true, settings: { ...settings, maxItemQuantity: 5 } },
    });
    expect(await readRuntimeConfig(deps.db)).toEqual({});
  });

  it('writes the override and replaces it on a second set', async () => {
    const { deps } = await setup();
    await put(deps, 'CHECKOUT_ENABLED', { value: 'false' }, '?dryRun=false');
    const res = await put(deps, 'CHECKOUT_ENABLED', { value: 'true' });
    expect(await res.json()).toMatchObject({ dryRun: false, from: 'false', to: 'true' });
    expect(await readRuntimeConfig(deps.db)).toEqual({ CHECKOUT_ENABLED: 'true' });
  });

  it('shows a restart would still fail when another setting is bad', async () => {
    const { deps } = await setup({ env: { OPS_SECRET: SECRET, SHIPPING_FLAT_CENTS: '-1' } });
    const body = (await (await put(deps, 'MAX_ITEM_QUANTITY', { value: '4' })).json()) as {
      afterRestart: { ok: boolean; error: string };
    };
    expect(body.afterRestart.ok).toBe(false);
    expect(body.afterRestart.error).toContain('SHIPPING_FLAT_CENTS');
  });

  it('rejects unknown keys, bad bodies and values the shop cannot read', async () => {
    const { deps } = await setup();
    const unknown = await put(deps, 'DATABASE_URL', { value: 'postgres://evil' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'unknown_key' });
    expect((await put(deps, 'MAX_ITEM_QUANTITY', { value: 3 })).status).toBe(400);
    expect((await put(deps, 'MAX_ITEM_QUANTITY', { value: '3', x: 1 })).status).toBe(400);
    const notJson = new Request('http://localhost/api/ops/config/MAX_ITEM_QUANTITY', {
      method: 'PUT',
      headers: { authorization: `Bearer ${SECRET}` },
      body: 'nope',
    });
    expect((await putConfig(notJson, 'MAX_ITEM_QUANTITY', deps)).status).toBe(400);
    for (const value of ['', '  ']) {
      const blank = await put(deps, 'SHIPPING_FLAT_CENTS', { value });
      expect(blank.status).toBe(400);
      expect(await blank.json()).toMatchObject({ error: 'invalid_value' });
    }
    const invalid = await put(deps, 'MAX_ITEM_QUANTITY', { value: '0' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_value' });
    expect(await readRuntimeConfig(deps.db)).toEqual({});
  });
});

describe('DELETE /api/ops/config/:key', () => {
  const del = (deps: OpsDeps, key: string, query = '') =>
    deleteConfig(call('DELETE', `/api/ops/config/${key}${query}`), key, deps);

  it('previews, then drops the override so the env value applies again', async () => {
    const { deps } = await setup({ env: { OPS_SECRET: SECRET, SHIPPING_FLAT_CENTS: '700' } });
    await setRuntimeConfig(deps.db, 'SHIPPING_FLAT_CENTS', '0');

    const preview: unknown = await (await del(deps, 'SHIPPING_FLAT_CENTS', '?dryRun=true')).json();
    expect(preview).toMatchObject({
      dryRun: true,
      env: '700',
      from: '0',
      to: null,
      afterRestart: { ok: true, settings: { shippingFlatCents: 700 } },
    });
    expect(await readRuntimeConfig(deps.db)).toEqual({ SHIPPING_FLAT_CENTS: '0' });

    expect((await del(deps, 'SHIPPING_FLAT_CENTS')).status).toBe(200);
    expect(await readRuntimeConfig(deps.db)).toEqual({});
  });

  it('rejects an unknown key', async () => {
    const { deps } = await setup();
    expect((await del(deps, 'OPS_SECRET')).status).toBe(404);
  });
});

describe('GET /api/ops/config', () => {
  it('lists each setting with its env value and override', async () => {
    const { deps } = await setup({ env: { OPS_SECRET: SECRET, CHECKOUT_ENABLED: 'false' } });
    await setRuntimeConfig(deps.db, 'CHECKOUT_ENABLED', 'true');
    const body = (await (await getConfig(call('GET', '/api/ops/config'), deps)).json()) as {
      settings: unknown[];
    };
    expect(body).toMatchObject({ current: settings, afterRestart: { ok: true } });
    expect(body.settings).toContainEqual({
      key: 'CHECKOUT_ENABLED',
      env: 'false',
      override: 'true',
    });
    expect(body.settings).toContainEqual({ key: 'MAX_ITEM_QUANTITY', env: null, override: null });
  });
});

describe('POST /api/ops/restart', () => {
  it('previews which settings a restart would change, without restarting', async () => {
    const { deps, restarter } = await setup();
    await setRuntimeConfig(deps.db, 'FREE_SHIPPING_MIN_CENTS', '9000');
    const res = await postRestart(call('POST', '/api/ops/restart?dryRun=true'), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      dryRun: true,
      current: settings,
      changed: ['freeShippingMinCents'],
    });
    expect(restarter.schedule).not.toHaveBeenCalled();
  });

  it('answers 202 and schedules the exit', async () => {
    const { deps, restarter } = await setup({ loaded: undefined });
    const res = await postRestart(call('POST', '/api/ops/restart'), deps);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      dryRun: false,
      restarting: true,
      current: null,
      changed: null,
    });
    expect(restarter.schedule).toHaveBeenCalledOnce();
  });

  it('refuses to restart into settings that do not parse, dry run or not', async () => {
    const { deps, restarter } = await setup({
      env: { OPS_SECRET: SECRET, MAX_ITEM_QUANTITY: 'x' },
    });
    for (const query of ['?dryRun=true', '']) {
      const res = await postRestart(call('POST', `/api/ops/restart${query}`), deps);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: 'settings_invalid',
        afterRestart: { ok: false },
        changed: null,
      });
    }
    expect(restarter.schedule).not.toHaveBeenCalled();
  });
});
