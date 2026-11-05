import { describe, expect, it } from 'vitest';
import {
  checkShopSetting,
  databaseUrl,
  isShopSettingKey,
  loadShopSettings,
  SHOP_SETTING_KEYS,
} from './config.ts';

describe('databaseUrl', () => {
  it('accepts a postgres url', () => {
    const url = 'postgres://page:page@localhost:5432/demo';
    expect(databaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it('rejects a missing or non-postgres url', () => {
    expect(() => databaseUrl({})).toThrow();
    expect(() => databaseUrl({ DATABASE_URL: 'mysql://x@localhost/demo' })).toThrow();
  });

  it('ignores a bad shop setting', () => {
    const url = 'postgres://page:page@localhost:5432/demo';
    expect(databaseUrl({ DATABASE_URL: url, MAX_ITEM_QUANTITY: '0' })).toBe(url);
  });
});

describe('loadShopSettings', () => {
  it('fills defaults', () => {
    expect(loadShopSettings({})).toEqual({
      shippingFlatCents: 500,
      freeShippingMinCents: 5000,
      maxItemQuantity: 10,
      checkoutEnabled: true,
    });
  });

  it('reads settings from the environment', () => {
    const settings = loadShopSettings({
      SHIPPING_FLAT_CENTS: '0',
      MAX_ITEM_QUANTITY: '3',
      CHECKOUT_ENABLED: 'false',
    });
    expect(settings).toMatchObject({
      shippingFlatCents: 0,
      maxItemQuantity: 3,
      checkoutEnabled: false,
    });
  });

  it('rejects a bad setting', () => {
    expect(() => loadShopSettings({ MAX_ITEM_QUANTITY: '0' })).toThrow();
  });
});

describe('shop setting keys', () => {
  it('lists the env names the shop reads', () => {
    expect(SHOP_SETTING_KEYS).toContain('MAX_ITEM_QUANTITY');
    expect(isShopSettingKey('CHECKOUT_ENABLED')).toBe(true);
    expect(isShopSettingKey('DATABASE_URL')).toBe(false);
    expect(isShopSettingKey('toString')).toBe(false);
  });

  it('checks one value the way loadShopSettings reads it', () => {
    expect(checkShopSetting('MAX_ITEM_QUANTITY', '3')).toBeNull();
    expect(checkShopSetting('MAX_ITEM_QUANTITY', '0')).toMatch(/>=1|1/);
    expect(checkShopSetting('CHECKOUT_ENABLED', 'maybe')).not.toBeNull();
    // Coercion would read a blank as 0; an override refuses it.
    expect(checkShopSetting('SHIPPING_FLAT_CENTS', '')).toMatch(/empty/);
  });
});
