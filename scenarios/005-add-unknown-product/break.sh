#!/bin/sh
# addItem asserts the product row exists instead of checking, so adding an unknown product
# id reads .inCart off undefined and throws a TypeError (500) instead of a 404.
set -eu
f=apps/demo-app/src/shop/cart.ts
sed -i "/if (!product) throw new ShopError('not_found'/d; s/const product = rows\[0\];/const product = rows[0]!;/" "$f"
! grep -q 'if (!product) throw' "$f"
grep -q 'const product = rows\[0\]!;' "$f"
