#!/bin/sh
# Shop settings load from a real-looking environment full of unrelated variables and
# still read MAX_ITEM_QUANTITY.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const { loadShopSettings } = await import('./src/config.ts');
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/node',
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgres://page:page@db:5432/demo',
};
assert.deepEqual(loadShopSettings(env), {
  shippingFlatCents: 500,
  freeShippingMinCents: 5000,
  maxItemQuantity: 10,
  checkoutEnabled: true,
});
assert.equal(loadShopSettings({ ...env, MAX_ITEM_QUANTITY: '3' }).maxItemQuantity, 3);
JS
