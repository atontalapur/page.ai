#!/bin/sh
# Shop settings load with the defaults, with other sensible shipping values and with free
# shipping on everything (a minimum of 0).
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const { loadShopSettings } = await import('./src/config.ts');
assert.equal(loadShopSettings({}).freeShippingMinCents, 5000);
const custom = loadShopSettings({ SHIPPING_FLAT_CENTS: '700', FREE_SHIPPING_MIN_CENTS: '8000' });
assert.equal(custom.shippingFlatCents, 700);
assert.equal(custom.freeShippingMinCents, 8000);
assert.equal(loadShopSettings({ FREE_SHIPPING_MIN_CENTS: '0' }).freeShippingMinCents, 0);
JS
