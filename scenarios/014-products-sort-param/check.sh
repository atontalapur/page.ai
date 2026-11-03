#!/bin/sh
# GET /api/products never sends a ?sort= value Postgres can't order by: unknown keys get
# a 4xx or are ignored, and the default listing still works.
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
import { GET } from '../src/app/api/products/route.ts';

const h = vi.hoisted(() => ({ sql: [] as string[] }));
// Stands in for Postgres: ORDER BY has to name a real products column.
vi.mock('../src/app/data.ts', () => ({
  shop: async () => ({
    db: {
      query: async (text: string) => {
        h.sql.push(text);
        const columns = ['id', 'slug', 'name', 'description', 'price_cents', 'stock', 'created_at'];
        const orderBy = /order by (.*)$/s.exec(text)?.[1]?.trim();
        if (orderBy !== undefined && !/^\w+( (asc|desc))?$/i.test(orderBy)) {
          throw new Error(`syntax error at or near "${orderBy}"`);
        }
        if (orderBy !== undefined && !columns.includes(orderBy.split(' ')[0]!)) {
          throw new Error(`column "${orderBy}" does not exist`);
        }
        return {
          rows: [{ id: 1, slug: 'canvas-tote', name: 'Canvas Tote', description: '', priceCents: 2400, stock: 40 }],
        };
      },
    },
  }),
}));

const get = (query = '') => GET(new Request(`http://shop.test/api/products${query}`) as never);

it('lists products without a sort key', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect((await res.json())[0].slug).toBe('canvas-tote');
});

it('never sends a sort key Postgres cannot order by', async () => {
  for (const sort of ['price', 'nope', 'name; drop table products', '(select 1)']) {
    h.sql = [];
    const res = await get(`?sort=${encodeURIComponent(sort)}`);
    expect(res.status, sort).toBeLessThan(500);
    expect(h.sql.join('\n'), sort).not.toContain('drop table');
  }
});
TS
node_modules/.bin/vitest run --config "$d/vitest.config.js"
