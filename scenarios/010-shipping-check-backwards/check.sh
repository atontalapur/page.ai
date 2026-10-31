#!/bin/sh
# Shop settings load with the defaults and with other sensible shipping values.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const { loadShopSettings } = await import('./src/config.ts');
assert.equal(loadShopSettings({}).freeShippingMinCents, 5000);
const custom = loadShopSettings({ SHIPPING_FLAT_CENTS: '700', FREE_SHIPPING_MIN_CENTS: '8000' });
assert.equal(custom.shippingFlatCents, 700);
assert.equal(custom.freeShippingMinCents, 8000);
JS
