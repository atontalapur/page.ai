#!/bin/sh
# A cart cookie that isn't a uuid reads as no cart; a valid one comes back as is.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const { readCartId } = await import('./src/app/cart-session.ts');
const jar = (value) => ({
  get: () => (value === undefined ? undefined : { name: 'cart_id', value }),
});
const id = '0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e';
assert.equal(readCartId(jar(id)), id);
assert.equal(readCartId(jar(undefined)), undefined);
assert.equal(readCartId(jar('42')), undefined);
assert.equal(readCartId(jar('')), undefined);
JS
