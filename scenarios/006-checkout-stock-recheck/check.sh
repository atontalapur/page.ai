#!/bin/sh
# Checking out more than is left in stock fails with out_of_stock and changes nothing.
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
const { placeOrder } = await import('./src/shop/orders.ts');

const { rows } = await db.query(
  `insert into products (slug, name, price_cents, stock) values ('beanie', 'Beanie', 3200, 5) returning id`,
);
const productId = rows[0].id;
const first = await ensureCart(db);
const second = await ensureCart(db);
await addItem(db, first, productId, 3, settings);
await addItem(db, second, productId, 3, settings);

await placeOrder(db, first, settings);
await assert.rejects(placeOrder(db, second, settings), { name: 'ShopError', code: 'out_of_stock' });

const stock = await db.query('select stock from products where id = $1', [productId]);
assert.equal(stock.rows[0].stock, 2);
const orders = await db.query('select count(*)::int as n from orders');
assert.equal(orders.rows[0].n, 1);
const left = await db.query('select quantity from cart_items where cart_id = $1', [second]);
assert.deepEqual(left.rows, [{ quantity: 3 }]);
JS
