#!/bin/sh
# No cookie means no cart, so the tote has no cart line.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/products/canvas-tote"
