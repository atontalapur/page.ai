#!/bin/sh
# The home page renders for any search text, including regex metacharacters, and still
# lists products without one.
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
cat > "$d/home.test.tsx" <<'TSX'
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import HomePage from '../src/app/page.tsx';

vi.mock('../src/app/data.ts', () => ({
  shop: async () => ({
    db: {
      query: async () => ({
        rows: [
          { id: 1, slug: 'canvas-tote', name: 'Canvas Tote', description: '', priceCents: 2400, stock: 40 },
          { id: 2, slug: 'enamel-mug', name: 'Enamel Mug', description: '', priceCents: 1600, stock: 25 },
        ],
      }),
    },
  }),
}));

const render = async (searchParams: Record<string, string>) =>
  renderToStaticMarkup(
    await (HomePage as (props: unknown) => ReturnType<typeof HomePage>)({
      params: Promise.resolve({}),
      searchParams: Promise.resolve(searchParams),
    }),
  );

it('lists every product without a search', async () => {
  const html = await render({});
  expect(html).toContain('href="/products/canvas-tote"');
  expect(html).toContain('href="/products/enamel-mug"');
});

it('renders for searches with regex metacharacters', async () => {
  for (const q of ['(', '[', 'mug)', '*', '\\']) {
    expect(await render({ q })).toContain('<h1>Products</h1>');
  }
});

it('still finds a product by name', async () => {
  expect(await render({ q: 'mug' })).toContain('href="/products/enamel-mug"');
});
TSX
node_modules/.bin/vitest run --config "$d/vitest.config.js"
