#!/bin/sh
# Checking out a cart with two products places the order, takes the stock and empties the
# cart, leaving another cart alone.
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

const { addItem, ensureCart, getCart } = await import('./src/shop/cart.ts');
const { getOrder, placeOrder } = await import('./src/shop/orders.ts');

const { rows } = await db.query(
  `insert into products (slug, name, price_cents, stock)
   values ('mug', 'Mug', 1600, 5), ('tote', 'Tote', 2400, 5) returning id`,
);
const [mug, tote] = rows.map((r) => r.id);
const cartId = await ensureCart(db);
const other = await ensureCart(db);
await addItem(db, cartId, mug, 1, settings);
await addItem(db, cartId, tote, 2, settings);
await addItem(db, other, mug, 1, settings);

const order = await getOrder(db, await placeOrder(db, cartId, settings));
assert.equal(order.items.length, 2);
assert.equal(order.totalCents, 6400);
assert.deepEqual((await getCart(db, cartId, settings)).lines, []);
assert.equal((await getCart(db, other, settings)).lines.length, 1);
const stock = await db.query('select stock from products order by id');
assert.deepEqual(stock.rows, [{ stock: 4 }, { stock: 3 }]);
JS
