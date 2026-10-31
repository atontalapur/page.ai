#!/bin/sh
# A migration renames products.price_cents to unit_price_cents to match order_items.
# products.ts and seed.ts were updated, but the cart and checkout queries still select
# p.price_cents, so adding to the cart, the cart page and checkout all throw.
set -eu
d=apps/demo-app
cat > "$d/migrations/002_rename_price_cents.sql" <<'SQL'
alter table products rename column price_cents to unit_price_cents;
SQL
sed -i 's/price_cents as "priceCents"/unit_price_cents as "priceCents"/' "$d/src/shop/products.ts"
sed -i 's/insert into products (slug, name, description, price_cents, stock)/insert into products (slug, name, description, unit_price_cents, stock)/; s/price_cents = excluded.price_cents/unit_price_cents = excluded.unit_price_cents/' "$d/src/db/seed.ts"
grep -q 'unit_price_cents as "priceCents"' "$d/src/shop/products.ts"
grep -q 'unit_price_cents = excluded.unit_price_cents' "$d/src/db/seed.ts"
