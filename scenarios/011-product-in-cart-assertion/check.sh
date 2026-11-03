#!/bin/sh
# The product page renders with no cart, with a cart that doesn't hold the product, and
# with one that does.
set -eu
cd apps/demo-app
d=.page-check
# A check killed before its trap ran leaves the directory behind.
rm -rf "$d"
mkdir "$d"
trap 'rm -rf "$d"' EXIT
cat > "$d/vitest.config.js" <<'JS'
export default { test: { include: ['.page-check/*.test.tsx'] } };
JS
cat > "$d/product.test.tsx" <<'TSX'
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import ProductPage from '../src/app/products/[slug]/page.tsx';

const CART = '6f1c2b6e-9a0d-4c55-8a3e-2b7d4f0e1a10';
const tote = {
  id: 1, slug: 'canvas-tote', name: 'Canvas Tote', description: 'Heavy cotton tote.',
  priceCents: 2400, stock: 40,
};
const h = vi.hoisted(() => ({ cartId: undefined as string | undefined, lines: [] as object[] }));
vi.mock('../src/app/data.ts', () => ({
  shop: async () => ({
    db: {
      query: async (text: string) => ({
        rows: text.includes('from cart_items') ? h.lines : text.includes('from products') ? [tote] : [],
      }),
    },
    settings: { shippingFlatCents: 500, freeShippingMinCents: 5000, maxItemQuantity: 10, checkoutEnabled: true },
    cookies: {
      get: (name: string) => (name === 'cart_id' && h.cartId ? { name, value: h.cartId } : undefined),
      set: () => {},
    },
  }),
}));

const render = async () =>
  renderToStaticMarkup(
    await ProductPage({
      params: Promise.resolve({ slug: 'canvas-tote' }),
      searchParams: Promise.resolve({}),
    } as never),
  );

it('renders for a shopper with no cart', async () => {
  h.cartId = undefined;
  h.lines = [];
  expect(await render()).toContain('<h1>Canvas Tote</h1>');
});

it('renders when the cart holds other products', async () => {
  h.cartId = CART;
  h.lines = [
    { productId: 2, slug: 'enamel-mug', name: 'Enamel Mug', unitPriceCents: 1600, quantity: 1, lineTotalCents: 1600 },
  ];
  expect(await render()).toContain('<h1>Canvas Tote</h1>');
});

it('renders when the cart holds this product', async () => {
  h.cartId = CART;
  h.lines = [
    { productId: 1, slug: 'canvas-tote', name: 'Canvas Tote', unitPriceCents: 2400, quantity: 2, lineTotalCents: 4800 },
  ];
  expect(await render()).toContain('<h1>Canvas Tote</h1>');
});
TSX
node_modules/.bin/vitest run --config "$d/vitest.config.js"
