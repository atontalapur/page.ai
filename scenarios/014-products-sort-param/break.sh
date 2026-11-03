#!/bin/sh
# GET /api/products takes a ?sort= param and listProducts splices it into "order by".
# Anything that isn't a products column, like ?sort=price, makes Postgres throw "column
# does not exist" (500), and the param is open to SQL injection.
set -eu
d=apps/demo-app/src
node - "$d/shop/products.ts" "$d/app/api/products/route.ts" "$d/app/api/api.test.ts" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const edit = (f, pairs) => {
  let src = readFileSync(f, 'utf8');
  for (const [from, to] of pairs) {
    if (!src.includes(from)) process.exit(1);
    src = src.replace(from, to);
  }
  writeFileSync(f, src);
};
edit(process.argv[2], [
  [
    'export async function listProducts(db: Queryable): Promise<Product[]> {\n' +
      '  const { rows } = await db.query<Product>(`select ${columns} from products order by name`);\n',
    '/** Lists the catalogue ordered by `orderBy`, a products column (name by default). */\n' +
      "export async function listProducts(db: Queryable, orderBy = 'name'): Promise<Product[]> {\n" +
      '  const { rows } = await db.query<Product>(`select ${columns} from products order by ${orderBy}`);\n',
  ],
]);
edit(process.argv[3], [
  [
    'export async function GET() {\n  const { db } = await shop();\n  return Response.json(await listProducts(db));\n',
    'export async function GET(req: Request) {\n' +
      "  const sort = new URL(req.url).searchParams.get('sort') ?? 'name';\n" +
      '  const { db } = await shop();\n' +
      '  return Response.json(await listProducts(db, sort));\n',
  ],
]);
edit(process.argv[4], [['await listProducts()', 'await listProducts(req)']]);
JS
grep -q 'order by ${orderBy}' "$d/shop/products.ts"
grep -q 'listProducts(db, sort)' "$d/app/api/products/route.ts"
grep -q "await listProducts(req)" "$d/app/api/api.test.ts"
