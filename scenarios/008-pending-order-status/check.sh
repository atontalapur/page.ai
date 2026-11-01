#!/bin/sh
# Checkout creates an order that can be read back, and orders_status_check still holds.
# Widening the constraint and inserting 'placed' again are both accepted: the clean app
# (which this must pass on) creates 'placed' orders.
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
const { getOrder, placeOrder } = await import('./src/shop/orders.ts');

const { rows } = await db.query(
  `insert into products (slug, name, price_cents, stock) values ('tote', 'Tote', 2400, 5) returning id`,
);
const cartId = await ensureCart(db);
await addItem(db, cartId, rows[0].id, 1, settings);
const order = await getOrder(db, await placeOrder(db, cartId, settings));
assert.ok(['pending', 'placed'].includes(order.status), order.status);
assert.equal(order.totalCents, 2900);
assert.equal(order.items.length, 1);
const stock = await db.query('select stock from products where id = $1', [rows[0].id]);
assert.equal(stock.rows[0].stock, 4);
await assert.rejects(
  db.query(
    `insert into orders (status, subtotal_cents, shipping_cents, total_cents) values ('lost', 0, 0, 0)`,
  ),
  /orders_status_check/,
);
JS
