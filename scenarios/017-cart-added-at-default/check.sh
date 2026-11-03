#!/bin/sh
# On a migrated, seeded database a shopper can add to the cart and add more of the same.
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
const settings = { shippingFlatCents: 500, freeShippingMinCents: 5000, maxItemQuantity: 10, checkoutEnabled: true };

const { seed } = await import('./src/db/seed.ts');
const { getProduct } = await import('./src/shop/products.ts');
const { addItem, ensureCart, getCart } = await import('./src/shop/cart.ts');

await seed(db);
const tote = await getProduct(db, 'canvas-tote');
const cartId = await ensureCart(db);
await addItem(db, cartId, tote.id, 1, settings);
await addItem(db, cartId, tote.id, 2, settings);
const cart = await getCart(db, cartId, settings);
assert.deepEqual(cart.lines.map((l) => [l.slug, l.quantity]), [['canvas-tote', 3]]);
JS
