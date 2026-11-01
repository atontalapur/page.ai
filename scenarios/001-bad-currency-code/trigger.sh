#!/bin/sh
# The home page lists products with their prices, so it renders formatCents.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/"
