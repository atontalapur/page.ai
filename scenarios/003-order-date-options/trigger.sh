#!/bin/sh
# Places an order with a fresh cart, then opens its page.
set -eu
url="${DEMO_APP_URL:?}"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT
id="$(curl -sS "$url/api/products/canvas-tote" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
curl -sS -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' \
  -d "{\"productId\":$id}" "$url/api/cart/items"
order="$(curl -sS -b "$jar" -X POST "$url/api/orders" | sed -n 's/.*"orderId":\([0-9]*\).*/\1/p')"
curl -sS -o /dev/null -w '%{http_code}\n' "$url/orders/$order"
