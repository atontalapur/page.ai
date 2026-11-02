#!/bin/sh
# The products API lists the catalogue with the joined query.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/api/products"
