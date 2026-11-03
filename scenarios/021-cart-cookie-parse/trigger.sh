#!/bin/sh
# Opens the cart with a cookie that isn't a uuid, like one left from an older cart id format.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' -b 'cart_id=42' "${DEMO_APP_URL:?}/cart"
