#!/bin/sh
# The order page 404s for an order that doesn't exist and still renders one that does.
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

const h = vi.hoisted(() => ({ order: undefined as object | undefined }));
vi.mock('../src/app/data.ts', () => ({
  shop: async () => ({
    db: {
      query: async (text: string) => ({
        rows: !h.order ? [] : text.includes('from orders') ? [h.order] : [],
      }),
    },
  }),
}));

const props = (id: string) =>
  ({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }) as never;

it('returns a 404 for an order that does not exist', async () => {
  h.order = undefined;
  const err = await OrderPage(props('999999')).catch((e: unknown) => e);
  expect((err as { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
});

it('renders an order that exists', async () => {
  h.order = {
    id: 7, status: 'placed', subtotalCents: 2400, shippingCents: 500, totalCents: 2900,
    createdAt: new Date('2026-10-01T12:00:00Z'),
  };
  const html = renderToStaticMarkup(await OrderPage(props('7')));
  expect(html).toContain('<h1>Order #7</h1>');
  expect(html).toContain('$29.00');
});
TSX
node_modules/.bin/vitest run --config "$d/vitest.config.js"
