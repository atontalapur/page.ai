#!/bin/sh
# An order page renders, with its total and the date it was placed.
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
cat > "$d/order.test.tsx" <<'TSX'
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import OrderPage from '../src/app/orders/[id]/page.tsx';

const order = {
  id: 7, status: 'placed', subtotalCents: 2400, shippingCents: 500, totalCents: 2900,
  createdAt: new Date('2026-10-01T12:00:00Z'),
};
const item = { productId: 1, name: 'Canvas Tote', quantity: 1, unitPriceCents: 2400 };
vi.mock('../src/app/data.ts', () => ({
  shop: async () => ({
    db: {
      query: async (text: string) => ({
        rows: text.includes('from order_items') ? [item] : [order],
      }),
    },
  }),
}));

it('renders an order', async () => {
  const props = { params: Promise.resolve({ id: '7' }), searchParams: Promise.resolve({}) };
  const html = renderToStaticMarkup(await OrderPage(props as never));
  expect(html).toContain('Canvas Tote');
  expect(html).toContain('$29.00');
  expect(html).toMatch(/Placed[^<]*2026/);
});
TSX
node_modules/.bin/vitest run --config "$d/vitest.config.js"
