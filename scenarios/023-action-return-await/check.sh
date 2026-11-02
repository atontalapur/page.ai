#!/bin/sh
# A ShopError in the add-to-cart and checkout actions sends the shopper back to the cart
# with its code; any other error still throws.
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
cat > "$d/actions.test.ts" <<'TS'
import { expect, it, vi } from 'vitest';
import { addToCart, checkout } from '../src/app/actions.ts';
import { ShopError } from '../src/shop/errors.ts';

const h = vi.hoisted(() => ({ fail: undefined as Error | undefined }));
vi.mock('../src/app/data.ts', () => ({
  shop: async () => ({ db: {}, settings: {}, cookies: {} }),
}));
vi.mock('../src/app/cart-session.ts', () => ({
  openCart: async () => '0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e',
  readCartId: () => '0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e',
}));
vi.mock('../src/shop/cart.ts', () => ({
  addItem: async () => {
    if (h.fail) throw h.fail;
  },
  removeItem: async () => {},
}));
vi.mock('../src/shop/orders.ts', () => ({
  placeOrder: async () => {
    if (h.fail) throw h.fail;
    return 7;
  },
}));

async function whereTo(work: Promise<unknown>): Promise<string> {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  const digest = (err as { digest?: string } | undefined)?.digest ?? '';
  if (!digest.startsWith('NEXT_REDIRECT')) throw err ?? new Error('expected a redirect');
  return digest.split(';')[2] ?? '';
}

const form = () => {
  const data = new FormData();
  data.set('productId', '1');
  data.set('quantity', '999');
  return data;
};

it('sends a shop error from add to cart back to the cart page', async () => {
  h.fail = new ShopError('invalid_quantity', 'At most 10 per item');
  expect(await whereTo(addToCart(form()))).toBe('/cart?error=invalid_quantity');
});

it('sends a shop error from checkout back to the cart page', async () => {
  h.fail = new ShopError('empty_cart', 'Cart is empty');
  expect(await whereTo(checkout())).toBe('/cart?error=empty_cart');
});

it('still adds and checks out', async () => {
  h.fail = undefined;
  expect(await whereTo(addToCart(form()))).toBe('/cart');
  expect(await whereTo(checkout())).toBe('/orders/7');
});

it('lets other errors through', async () => {
  h.fail = new Error('db down');
  await expect(checkout()).rejects.toThrow('db down');
});
TS
node_modules/.bin/vitest run --config "$d/vitest.config.js"
