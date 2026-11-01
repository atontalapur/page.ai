#!/bin/sh
# No order has this id, so the page should 404 but throws instead.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/orders/999999"
