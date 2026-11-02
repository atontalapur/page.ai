#!/bin/sh
# On a migrated, seeded database the catalogue lists in name order and products load by
# slug.
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

const { seed } = await import('./src/db/seed.ts');
const { getProduct, listProducts } = await import('./src/shop/products.ts');

await seed(db);
const all = await listProducts(db);
assert.deepEqual(
  all.map((p) => p.name),
  ['Brass Keyring', 'Canvas Tote', 'Enamel Mug', 'Field Notebook', 'Wool Beanie'],
);
const tote = await getProduct(db, 'canvas-tote');
assert.equal(tote.slug, 'canvas-tote');
assert.equal(tote.name, 'Canvas Tote');
assert.equal(tote.priceCents, 2400);
assert.equal(tote.id, all.find((p) => p.slug === 'canvas-tote').id);
assert.equal(await getProduct(db, 'no-such-product'), null);
JS
