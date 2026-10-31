#!/bin/sh
# addItem no longer checks that the product exists, so adding an unknown product id
# reads .inCart off undefined and throws a TypeError (500) instead of a 404.
set -eu
f=apps/demo-app/src/shop/cart.ts
sed -i "/if (!product) throw new ShopError('not_found'/d" "$f"
! grep -q 'if (!product) throw' "$f"
