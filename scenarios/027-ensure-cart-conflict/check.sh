#!/bin/sh
# A shopper can keep adding to the same cart, and a cart id whose row is gone is recreated.
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
await addItem(db, cartId, rows[0].id, 1, settings);
assert.equal(await ensureCart(db, cartId), cartId);
await addItem(db, await ensureCart(db, cartId), rows[0].id, 1, settings);
const { rows: lines } = await db.query('select quantity from cart_items where cart_id = $1', [cartId]);
assert.deepEqual(lines, [{ quantity: 2 }]);

const lost = '0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e';
assert.equal(await ensureCart(db, lost), lost);
const carts = await db.query('select count(*)::int as n from carts');
assert.equal(carts.rows[0].n, 2);
JS
