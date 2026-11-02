#!/bin/sh
# getProduct learns to find a product by id as well as slug, with "where id = $1 or
# slug = $1", so /products/2 and /api/products/2 work as well as the slug URLs (both
# routes hand their URL segment straight to getProduct). Postgres types $1 from its
# first use as an integer, so "slug = $1" compares text to integer and every product
# lookup throws: product pages and /api/products/[slug] return 500.
set -eu
f=apps/demo-app/src/shop/products.ts
node - "$f" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const f = process.argv[2];
let src = readFileSync(f, 'utf8');
for (const [from, to] of [
  [
    'export async function getProduct(db: Queryable, slug: string): Promise<Product | null> {\n' +
      '  const { rows } = await db.query<Product>(`select ${columns} from products where slug = $1`, [\n' +
      '    slug,\n' +
      '  ]);\n',
    '/** Finds a product by slug, or by id, so /products/<id> URLs resolve too. */\n' +
      'export async function getProduct(db: Queryable, slugOrId: string): Promise<Product | null> {\n' +
      '  const { rows } = await db.query<Product>(\n' +
      '    `select ${columns} from products where id = $1 or slug = $1`,\n' +
      '    [slugOrId],\n' +
      '  );\n',
  ],
]) {
  if (!src.includes(from)) process.exit(1);
  src = src.replace(from, to);
}
writeFileSync(f, src);
JS
grep -q 'where id = $1 or slug = $1' "$f"
