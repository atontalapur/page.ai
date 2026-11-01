#!/bin/sh
# No product has this id.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' \
  -d '{"productId":999999}' "${DEMO_APP_URL:?}/api/cart/items"
