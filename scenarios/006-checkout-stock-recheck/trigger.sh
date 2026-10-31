#!/bin/sh
# Two carts each add more than half the beanies in stock, which together is more than the
# stock. The first checkout succeeds and the second throws. Each run uses up stock, so this
# works until the beanie sells out; reseeding resets it. Set MAX_ITEM_QUANTITY to match the
# app's if it isn't the default.
set -eu
url="${DEMO_APP_URL:?}"
max="${MAX_ITEM_QUANTITY:-10}"
a="$(mktemp)"
b="$(mktemp)"
trap 'rm -f "$a" "$b"' EXIT
product="$(curl -sS "$url/api/products/wool-beanie")"
id="$(echo "$product" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
stock="$(echo "$product" | sed -n 's/.*"stock":\([0-9]*\).*/\1/p')"
: "${id:?no wool-beanie product}" "${stock:?no stock in $product}"
qty=$((stock < max ? stock : max))
if [ "$qty" -lt 1 ] || [ $((qty * 2)) -le "$stock" ]; then
  echo "can't oversell: stock $stock, at most $max per cart; reseed the app" >&2
  exit 1
fi
for jar in "$a" "$b"; do
  curl -sSf -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' \
    -d "{\"productId\":$id,\"quantity\":$qty}" "$url/api/cart/items"
done
curl -sSf -o /dev/null -b "$a" -X POST "$url/api/orders"
curl -sS -o /dev/null -w '%{http_code}\n' -b "$b" -X POST "$url/api/orders"
