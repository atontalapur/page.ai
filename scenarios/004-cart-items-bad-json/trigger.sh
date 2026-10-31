#!/bin/sh
# A truncated JSON body.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' \
  -d '{"productId":' "${DEMO_APP_URL:?}/api/cart/items"
