#!/bin/sh
# Checks out one mug, which is under the free-shipping minimum, so the order pays the flat
# fee. Fires only where SHIPPING_FLAT_CENTS is unset. Each run uses up an enamel mug;
# reseeding resets the stock.
set -eu
url="${DEMO_APP_URL:?}"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT
id="$(curl -sS "$url/api/products/enamel-mug" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
: "${id:?no enamel-mug product}"
curl -sSf -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' \
  -d "{\"productId\":$id}" "$url/api/cart/items"
curl -sS -o /dev/null -w '%{http_code}\n' -b "$jar" -X POST "$url/api/orders"
