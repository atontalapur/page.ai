#!/bin/sh
# "price" reads like a sort key, but products has no column by that name.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/api/products?sort=price"
