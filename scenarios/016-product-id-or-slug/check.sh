#!/bin/sh
# On a migrated, seeded database getProduct finds a product by slug and returns null for
# a slug that doesn't exist.
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
const { getProduct } = await import('./src/shop/products.ts');

await seed(db);
const mug = await getProduct(db, 'enamel-mug');
assert.equal(mug.name, 'Enamel Mug');
assert.equal(mug.priceCents, 1600);
assert.equal(await getProduct(db, 'no-such-product'), null);
JS
