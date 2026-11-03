#!/bin/sh
# Clearing the ordered lines from the cart is rewritten as `product_id in ($2)`. node-pg
# sends the id array as one array literal, which Postgres can't read as an integer, so
# the last statement of every checkout throws and rolls the order back.
set -eu
f=apps/demo-app/src/shop/orders.ts
sed -i 's/delete from cart_items where cart_id = \$1 and product_id = any(\$2::int\[\])/delete from cart_items where cart_id = $1 and product_id in ($2)/' "$f"
grep -q 'delete from cart_items where cart_id = \$1 and product_id in (\$2)' "$f"
