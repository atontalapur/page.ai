#!/bin/sh
# Checks out a fresh cart with one notebook in it. Each run uses up a field notebook (shared
# with 025); reseeding resets the stock.
set -eu
url="${DEMO_APP_URL:?}"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT
id="$(curl -sS "$url/api/products/field-notebook" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
: "${id:?no field-notebook product}"
curl -sSf -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' \
  -d "{\"productId\":$id}" "$url/api/cart/items"
curl -sS -o /dev/null -w '%{http_code}\n' -b "$jar" -X POST "$url/api/orders"
