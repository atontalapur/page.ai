#!/bin/sh
# Two carts each add as many beanies as they can, which together is more than the stock.
# The first checkout succeeds and the second throws. Each run uses up stock, so this works
# until the beanie sells out; reseeding resets it.
set -eu
url="${DEMO_APP_URL:?}"
a="$(mktemp)"
b="$(mktemp)"
trap 'rm -f "$a" "$b"' EXIT
product="$(curl -sS "$url/api/products/wool-beanie")"
id="$(echo "$product" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
stock="$(echo "$product" | sed -n 's/.*"stock":\([0-9]*\).*/\1/p')"
qty=$((stock < 10 ? stock : 10))
for jar in "$a" "$b"; do
  curl -sS -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' \
    -d "{\"productId\":$id,\"quantity\":$qty}" "$url/api/cart/items"
done
curl -sS -o /dev/null -b "$a" -X POST "$url/api/orders"
curl -sS -o /dev/null -w '%{http_code}\n' -b "$b" -X POST "$url/api/orders"
