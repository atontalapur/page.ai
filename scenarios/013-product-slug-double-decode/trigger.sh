#!/bin/sh
# No product has the slug "50%-off", so this should be a 404.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/api/products/50%25-off"
