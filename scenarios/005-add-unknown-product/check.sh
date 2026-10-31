#!/bin/sh
# Adding a product that does not exist fails with a not_found ShopError.
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

const { addItem, ensureCart } = await import('./src/shop/cart.ts');

const { rows } = await db.query(
  `insert into products (slug, name, price_cents, stock) values ('mug', 'Mug', 1600, 5) returning id`,
);
const cartId = await ensureCart(db);
await assert.rejects(addItem(db, cartId, 999999, 1, settings), { name: 'ShopError', code: 'not_found' });
await addItem(db, cartId, rows[0].id, 2, settings);
const { rows: lines } = await db.query('select quantity from cart_items where cart_id = $1', [cartId]);
assert.deepEqual(lines, [{ quantity: 2 }]);
JS
