#!/bin/sh
# Any product lookup runs the broken query.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/api/products/canvas-tote"
