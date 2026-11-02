#!/bin/sh
# Reads the cart with an x-cart-id header that isn't a uuid.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' -H 'x-cart-id: 42' "${DEMO_APP_URL:?}/api/cart"
