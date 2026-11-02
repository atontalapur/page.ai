#!/bin/sh
# On a migrated database holding rows the check inserts, the catalogue lists in name order
# and products load by slug.
set -eu
cd apps/demo-app
# --liftoff-only keeps PGlite's wasm compile under the sandbox's 1 GB (see vitest.config.js).
node --liftoff-only --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const { loadMigrations, migrate } = await import('./src/db/migrate.ts');

const pg = await PGlite.create();
const wrap = (c) => ({ query: (t, p) => c.query(t, p), exec: async (t) => void (await c.exec(t)) });
const db = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };
await migrate(db, await loadMigrations('migrations'));

const { getProduct, listProducts } = await import('./src/shop/products.ts');

// Its own rows, inserted out of name order, so the check doesn't depend on seed.ts.
const rows = [
  ['zinc-tray', 'Zinc Tray', 1800],
  ['agate-coaster', 'Agate Coaster', 900],
  ['mesh-bag', 'Mesh Bag', 1200],
];
for (const [slug, name, priceCents] of rows) {
  await db.query('insert into products (slug, name, price_cents, stock) values ($1, $2, $3, 5)', [
    slug,
    name,
    priceCents,
  ]);
}
const ours = new Set(rows.map(([slug]) => slug));
const all = (await listProducts(db)).filter((p) => ours.has(p.slug));
assert.deepEqual(
  all.map((p) => p.name),
  ['Agate Coaster', 'Mesh Bag', 'Zinc Tray'],
);
const bag = await getProduct(db, 'mesh-bag');
assert.equal(bag.slug, 'mesh-bag');
assert.equal(bag.name, 'Mesh Bag');
assert.equal(bag.priceCents, 1200);
assert.equal(bag.id, all.find((p) => p.slug === 'mesh-bag').id);
assert.equal(await getProduct(db, 'no-such-product'), null);
JS
