#!/bin/sh
# A migration adds product categories, and the product queries join categories to show
# each product's category. The select list and filters still use bare id, slug and name,
# which both tables now have, so Postgres throws "column reference is ambiguous" on the
# home page, product pages and the products API.
set -eu
d=apps/demo-app
cat > "$d/migrations/002_product_categories.sql" <<'SQL'
create table categories (
  id serial primary key,
  slug text not null unique,
  name text not null
);

alter table products add column category_id integer references categories (id);
SQL
node - "$d/src/shop/products.ts" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const f = process.argv[2];
let src = readFileSync(f, 'utf8');
for (const [from, to] of [
  ['  stock: number;\n}\n', '  stock: number;\n  category: string | null;\n}\n'],
  [
    'const columns = `id, slug, name, description, price_cents as "priceCents", stock`;\n',
    'const columns = `id, slug, name, description, price_cents as "priceCents", stock,\n' +
      '  c.name as category`;\n' +
      'const fromProducts = `products p left join categories c on c.id = p.category_id`;\n',
  ],
  ['`select ${columns} from products order by name`', '`select ${columns} from ${fromProducts} order by name`'],
  ['`select ${columns} from products where slug = $1`', '`select ${columns} from ${fromProducts} where slug = $1`'],
]) {
  if (!src.includes(from)) process.exit(1);
  src = src.replace(from, to);
}
writeFileSync(f, src);
JS
grep -q 'from ${fromProducts} order by name' "$d/src/shop/products.ts"
grep -q 'from ${fromProducts} where slug = $1' "$d/src/shop/products.ts"
