#!/bin/sh
# GET /api/cart starts accepting the cart id in an x-cart-id header for clients without
# cookies, but passes it straight to the query without the uuid check readCartId does.
# Any header that isn't a uuid makes Postgres throw, so the request is a 500.
set -eu
f=apps/demo-app/src/app/api/cart/route.ts
node - "$f" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const f = process.argv[2];
const before = readFileSync(f, 'utf8');
const old =
  'export async function GET() {\n' +
  '  const { db, settings, cookies } = await shop();\n' +
  '  return Response.json(await getCart(db, readCartId(cookies), settings));\n';
if (!before.includes(old)) process.exit(1);
writeFileSync(
  f,
  before.replace(
    old,
    'export async function GET(req: Request) {\n' +
      '  const { db, settings, cookies } = await shop();\n' +
      "  // Clients without cookies (the mobile app) send the cart id in a header.\n" +
      "  const cartId = req.headers.get('x-cart-id') ?? readCartId(cookies);\n" +
      '  return Response.json(await getCart(db, cartId, settings));\n',
  ),
);
JS
grep -q "const cartId = req.headers.get('x-cart-id') ?? readCartId(cookies);" "$f"
