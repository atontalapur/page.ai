#!/bin/sh
# ensureCart drops `on conflict (id) do nothing`, on the idea that the insert is only there
# for a cart lost in a database reset. Every request that already has a cart re-inserts
# its row and violates carts_pkey, so a shopper's second add to cart is a 500.
set -eu
f=apps/demo-app/src/shop/cart.ts
sed -i "s/await db.query('insert into carts (id) values (\$1) on conflict (id) do nothing', \[id\]);/await db.query('insert into carts (id) values (\$1)', [id]);/" "$f"
! grep -q 'on conflict (id) do nothing' "$f"
grep -q "await db.query('insert into carts (id) values (\$1)', \[id\]);" "$f"
