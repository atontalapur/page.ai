import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/test-utils.ts';
import {
  readRuntimeConfig,
  setRuntimeConfig,
  trySettings,
  unsetRuntimeConfig,
  withRuntimeConfig,
} from './runtime-config.ts';

describe('runtime config', () => {
  it('sets, replaces and unsets an override', async () => {
    const db = await createTestDb();
    await setRuntimeConfig(db, 'MAX_ITEM_QUANTITY', '3');
    await setRuntimeConfig(db, 'MAX_ITEM_QUANTITY', '4');
    expect(await readRuntimeConfig(db)).toEqual({ MAX_ITEM_QUANTITY: '4' });
    await unsetRuntimeConfig(db, 'MAX_ITEM_QUANTITY');
    expect(await readRuntimeConfig(db)).toEqual({});
  });

  it('skips rows for keys the code no longer knows', async () => {
    const db = await createTestDb();
    await db.query(`insert into runtime_config (key, value) values ('OLD_SETTING', '1')`);
    expect(await readRuntimeConfig(db)).toEqual({});
  });

  it('lays overrides over the env', () => {
    const env = withRuntimeConfig(
      { MAX_ITEM_QUANTITY: '0', OTHER: 'x' },
      { MAX_ITEM_QUANTITY: '2' },
    );
    expect(env).toEqual({ MAX_ITEM_QUANTITY: '2', OTHER: 'x' });
    expect(trySettings(env)).toMatchObject({ ok: true, settings: { maxItemQuantity: 2 } });
  });

  it('returns a bad setting as an error value', () => {
    expect(trySettings({ MAX_ITEM_QUANTITY: '0' })).toMatchObject({ ok: false });
  });
});
