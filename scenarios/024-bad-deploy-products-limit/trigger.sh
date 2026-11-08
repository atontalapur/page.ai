#!/bin/sh
# Lists the products, the way the storefront's API clients do.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/api/products"
