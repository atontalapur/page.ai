#!/bin/sh
# POST /api/cart/items answers a malformed body with a 400.
set -eu
cd apps/demo-app
d=.page-check
# A check killed before its trap ran leaves the directory behind.
rm -rf "$d"
mkdir "$d"
trap 'rm -rf "$d"' EXIT
cat > "$d/vitest.config.js" <<'JS'
export default { test: { include: ['.page-check/*.test.ts'] } };
JS
cat > "$d/route.test.ts" <<'TS'
import { expect, it, vi } from 'vitest';
import { POST } from '../src/app/api/cart/items/route.ts';

vi.mock('../src/app/data.ts', () => ({
  shop: async () => {
    throw new Error('a bad body should be refused before shop() is called');
  },
}));

const post = (body: string) =>
  POST(
    new Request('http://shop.test/api/cart/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );

it('refuses a body that is not JSON', async () => {
  const res = await post('{"productId":');
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('bad_request');
});

it('refuses JSON without a product id', async () => {
  expect((await post('{}')).status).toBe(400);
});
TS
node_modules/.bin/vitest run --config "$d/vitest.config.js"
