#!/bin/sh
# Checks out without a cart cookie, so the cart is empty.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "${DEMO_APP_URL:?}/api/orders"
