#!/bin/sh
# GET /api/cart never sends a cart id that isn't a uuid to the database, and still reads
# the cart named by the cookie.
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
import { GET } from '../src/app/api/cart/route.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const h = vi.hoisted(() => ({ cookie: undefined as string | undefined, queried: [] as unknown[] }));
vi.mock('../src/app/data.ts', () => ({
  shop: async () => ({
    db: {
      // Postgres rejects a cart id that isn't a uuid.
      query: async (_text: string, params: unknown[] = []) => {
        h.queried.push(params[0]);
        if (typeof params[0] !== 'string' || !uuid.test(params[0])) {
          throw new Error(`invalid input syntax for type uuid: "${String(params[0])}"`);
        }
        return { rows: [] };
      },
    },
    settings: { shippingFlatCents: 500, freeShippingMinCents: 5000 },
    cookies: { get: () => (h.cookie ? { name: 'cart_id', value: h.cookie } : undefined) },
  }),
}));

const get = (headers: Record<string, string> = {}) =>
  (GET as (req: Request) => Promise<Response>)(
    new Request('http://shop.test/api/cart', { headers }),
  );

it('does not send a malformed cart id to the database', async () => {
  h.cookie = undefined;
  const res = await get({ 'x-cart-id': 'not-a-uuid' });
  expect(res.status).toBeLessThan(500);
  expect(h.queried).not.toContain('not-a-uuid');
});

it('reads the cart from the cookie', async () => {
  h.cookie = '0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e';
  h.queried = [];
  const res = await get();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ lines: [], subtotalCents: 0, shippingCents: 0, totalCents: 0 });
  expect(h.queried).toEqual([h.cookie]);
});
TS
node_modules/.bin/vitest run --config "$d/vitest.config.js"
