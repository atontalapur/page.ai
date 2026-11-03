#!/bin/sh
# An order id past the int4 range should be a 404.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/orders/3000000000"
