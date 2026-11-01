#!/bin/sh
# Shop settings load from an empty environment with checkout on, and still read the variable.
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
assert.equal(loadShopSettings({ CHECKOUT_ENABLED: 'false' }).checkoutEnabled, false);
JS
