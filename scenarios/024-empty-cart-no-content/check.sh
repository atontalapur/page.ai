#!/bin/sh
# Every shop error code becomes a 4xx or 5xx JSON response naming the code, and an empty
# cart is still refused.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const { errorResponse, handle } = await import('./src/app/api/respond.ts');
const { ShopError, errorMessages } = await import('./src/shop/errors.ts');
for (const code of [...Object.keys(errorMessages), 'bad_request']) {
  const res = errorResponse(code, 'message');
  assert.ok(res.status >= 400 && res.status < 600, `${code}: ${res.status}`);
  assert.equal((await res.json()).error, code);
}
const res = await handle(async () => {
  throw new ShopError('empty_cart', 'Cart is empty');
});
assert.ok(res.status >= 400 && res.status < 500, `empty_cart: ${res.status}`);
assert.deepEqual(await res.json(), { error: 'empty_cart', message: 'Cart is empty' });
JS
