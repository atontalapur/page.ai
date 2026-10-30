import { describe, expect, it } from 'vitest';
import { loadConfig, shopSettings } from './config.ts';

const url = 'postgres://page:page@localhost:5432/demo';

describe('loadConfig', () => {
  it('fills shop defaults', () => {
    expect(shopSettings(loadConfig({ DATABASE_URL: url }))).toEqual({
      shippingFlatCents: 500,
      freeShippingMinCents: 5000,
      maxItemQuantity: 10,
      checkoutEnabled: true,
    });
  });

  it('reads shop settings from the environment', () => {
    const config = loadConfig({
      DATABASE_URL: url,
      SHIPPING_FLAT_CENTS: '0',
      MAX_ITEM_QUANTITY: '3',
      CHECKOUT_ENABLED: 'false',
    });
    expect(shopSettings(config)).toMatchObject({
      shippingFlatCents: 0,
      maxItemQuantity: 3,
      checkoutEnabled: false,
    });
  });

  it('rejects a missing or non-postgres url', () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x@localhost/demo' })).toThrow();
  });

  it('rejects a bad setting', () => {
    expect(() => loadConfig({ DATABASE_URL: url, MAX_ITEM_QUANTITY: '0' })).toThrow();
  });
});
