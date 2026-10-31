#!/bin/sh
# Places an order with a fresh cart, then opens its page. Each run uses up a canvas tote
# (shared with 008); reseeding resets the stock.
set -eu
url="${DEMO_APP_URL:?}"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT
id="$(curl -sS "$url/api/products/canvas-tote" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
: "${id:?no canvas-tote product}"
curl -sSf -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' \
  -d "{\"productId\":$id}" "$url/api/cart/items"
order="$(curl -sSf -b "$jar" -X POST "$url/api/orders" | sed -n 's/.*"orderId":\([0-9]*\).*/\1/p')"
: "${order:?checkout failed}"
curl -sS -o /dev/null -w '%{http_code}\n' "$url/orders/$order"
