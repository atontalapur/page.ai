#!/bin/sh
# POST /api/orders answers a checkout with 201 and the new order id, and an empty cart
# with a 409.
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
import { POST } from '../src/app/api/orders/route.ts';
import { ShopError } from '../src/shop/errors.ts';

const h = vi.hoisted(() => ({ empty: false }));
vi.mock('../src/app/data.ts', () => ({
  shop: async () => ({
    db: {},
    settings: {},
    cookies: { get: () => ({ name: 'cart_id', value: '0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e' }) },
  }),
}));
vi.mock('../src/shop/orders.ts', () => ({
  placeOrder: async () => {
    if (h.empty) throw new ShopError('empty_cart', 'Cart is empty');
    return 42;
  },
}));

const post = () =>
  (POST as (req: Request) => Promise<Response>)(
    new Request('http://shop.test/api/orders', { method: 'POST' }),
  );

it('returns the new order id', async () => {
  h.empty = false;
  const res = await post();
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ orderId: 42 });
});

it('refuses an empty cart', async () => {
  h.empty = true;
  expect((await post()).status).toBe(409);
});
TS
node_modules/.bin/vitest run --config "$d/vitest.config.js"
