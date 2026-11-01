#!/bin/sh
# Adding to the cart returns the cart, which selects the old column.
set -eu
url="${DEMO_APP_URL:?}"
id="$(curl -sS "$url/api/products/canvas-tote" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
curl -sS -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' \
  -d "{\"productId\":$id}" "$url/api/cart/items"
