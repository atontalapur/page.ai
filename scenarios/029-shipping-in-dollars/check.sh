#!/bin/sh
# Flat shipping is a whole number of cents: 500 by default, read from the variable when set,
# and a fractional value is refused.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const { loadShopSettings } = await import('./src/config.ts');
assert.equal(loadShopSettings({}).shippingFlatCents, 500);
assert.equal(loadShopSettings({ SHIPPING_FLAT_CENTS: '700' }).shippingFlatCents, 700);
assert.equal(loadShopSettings({ SHIPPING_FLAT_CENTS: '0' }).shippingFlatCents, 0);
assert.throws(() => loadShopSettings({ SHIPPING_FLAT_CENTS: '4.99' }));
JS
