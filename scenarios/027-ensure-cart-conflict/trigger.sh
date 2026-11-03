#!/bin/sh
# Adds a mug to a fresh cart, then adds another with the same cart cookie.
set -eu
url="${DEMO_APP_URL:?}"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT
id="$(curl -sS "$url/api/products/enamel-mug" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')"
: "${id:?no enamel-mug product}"
curl -sSf -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' \
  -d "{\"productId\":$id}" "$url/api/cart/items"
curl -sS -o /dev/null -w '%{http_code}\n' -b "$jar" -H 'content-type: application/json' \
  -d "{\"productId\":$id}" "$url/api/cart/items"
