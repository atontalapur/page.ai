#!/bin/sh
# The product page starts showing how many are already in your cart, but asserts the
# product has a cart line. For a product that isn't in the cart (or with no cart at all)
# find() returns undefined and reading .quantity throws, so product pages return 500.
set -eu
f='apps/demo-app/src/app/products/[slug]/page.tsx'
node - "$f" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const f = process.argv[2];
let src = readFileSync(f, 'utf8');
for (const [from, to] of [
  [
    "import { formatCents } from '../../../shop/money.ts';\n",
    "import { getCart } from '../../../shop/cart.ts';\nimport { formatCents } from '../../../shop/money.ts';\n",
  ],
  [
    "import { addToCart } from '../../actions.ts';\n",
    "import { addToCart } from '../../actions.ts';\nimport { readCartId } from '../../cart-session.ts';\n",
  ],
  ['const { db, settings } = await shop();', 'const { db, settings, cookies } = await shop();'],
  [
    '  if (!product) notFound();\n',
    '  if (!product) notFound();\n' +
      '  const cart = await getCart(db, readCartId(cookies), settings);\n' +
      '  const inCart = cart.lines.find((line) => line.productId === product.id)!.quantity;\n',
  ],
  [
    "      <p>{soldOut ? 'Sold out' : `${product.stock} in stock`}</p>\n",
    "      <p>{soldOut ? 'Sold out' : `${product.stock} in stock`}</p>\n" +
      '      {inCart > 0 && <p>{inCart} in your cart</p>}\n',
  ],
]) {
  if (!src.includes(from)) process.exit(1);
  src = src.replace(from, to);
}
writeFileSync(f, src);
JS
grep -q 'line.productId === product.id)!.quantity' "$f"
