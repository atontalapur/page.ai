#!/bin/sh
# Checks out a fresh cart with one tote in it. Each run uses up a canvas tote (shared with
# 003); reseeding resets the stock.
set -eu
url="${DEMO_APP_URL:?}"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT
id="$(curl -sS "$url/api/products/canvas-tote" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
: "${id:?no canvas-tote product}"
curl -sSf -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' \
  -d "{\"productId\":$id}" "$url/api/cart/items"
curl -sS -o /dev/null -w '%{http_code}\n' -b "$jar" -X POST "$url/api/orders"
