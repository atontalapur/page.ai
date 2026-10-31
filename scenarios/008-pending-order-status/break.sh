#!/bin/sh
# New orders start as 'pending' until payment confirms them (a later step marks them
# 'placed'), but no migration adds 'pending' to orders_status_check, so every checkout
# violates the constraint and throws.
set -eu
f=apps/demo-app/src/shop/orders.ts
sed -i "s/status: 'placed' | 'cancelled';/status: 'pending' | 'placed' | 'cancelled';/" "$f"
sed -i 's/`insert into orders (subtotal_cents, shipping_cents, total_cents)/`insert into orders (status, subtotal_cents, shipping_cents, total_cents)/' "$f"
sed -i "s/       values (\$1, \$2, \$3) returning id\`,/       values ('pending', \$1, \$2, \$3) returning id\`,/" "$f"
grep -q "status: 'pending' | 'placed' | 'cancelled';" "$f"
grep -q 'insert into orders (status, subtotal_cents, shipping_cents, total_cents)' "$f"
grep -q "values ('pending', \$1, \$2, \$3) returning id" "$f"
