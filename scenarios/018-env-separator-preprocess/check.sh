#!/bin/sh
# Shop settings load their defaults from an empty environment and still read the item
# limit and free-shipping minimum when they're set.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const { loadShopSettings } = await import('./src/config.ts');
assert.deepEqual(loadShopSettings({}), {
  shippingFlatCents: 500,
  freeShippingMinCents: 5000,
  maxItemQuantity: 10,
  checkoutEnabled: true,
});
const set = loadShopSettings({ MAX_ITEM_QUANTITY: '4', FREE_SHIPPING_MIN_CENTS: '7500' });
assert.equal(set.maxItemQuantity, 4);
assert.equal(set.freeShippingMinCents, 7500);
JS
