#!/bin/sh
# GET /api/products/[slug] looks up the slug exactly as Next hands it over (already
# decoded): a slug containing % gets a 404, and a real one still returns the product.
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
import { GET } from '../src/app/api/products/[slug]/route.ts';

const h = vi.hoisted(() => ({ looked: [] as unknown[] }));
vi.mock('../src/app/data.ts', () => ({
  shop: async () => ({
    db: {
      query: async (_text: string, params: unknown[] = []) => {
        h.looked.push(params[0]);
        const slug = params[0];
        return {
          rows:
            slug === 'canvas-tote' || slug === '100%-cotton'
              ? [{ id: 1, slug, name: 'Canvas Tote', description: '', priceCents: 2400, stock: 40 }]
              : [],
        };
      },
    },
  }),
}));

// Next decodes route params before the handler sees them.
const get = (slug: string) =>
  GET(new Request(`http://shop.test/api/products/${encodeURIComponent(slug)}`), {
    params: Promise.resolve({ slug }),
  } as never);

it('returns 404 for unknown slugs containing %', async () => {
  for (const slug of ['50%-off', '%', '%E0%A4%A']) {
    expect((await get(slug)).status, slug).toBe(404);
  }
});

it('finds a product by its slug as given', async () => {
  const res = await get('canvas-tote');
  expect(res.status).toBe(200);
  expect((await res.json()).slug).toBe('canvas-tote');
});

it('does not decode the slug a second time', async () => {
  h.looked = [];
  const res = await get('100%-cotton');
  expect(res.status).toBe(200);
  expect(h.looked).toContain('100%-cotton');
});
TS
node_modules/.bin/vitest run --config "$d/vitest.config.js"
