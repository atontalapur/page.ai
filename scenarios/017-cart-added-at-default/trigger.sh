#!/bin/sh
# Adds a tote to a fresh cart, which inserts a cart_items row.
set -eu
url="${DEMO_APP_URL:?}"
id="$(curl -sS "$url/api/products/canvas-tote" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
: "${id:?no canvas-tote product}"
curl -sS -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' \
  -d "{\"productId\":$id}" "$url/api/cart/items"
