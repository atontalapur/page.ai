#!/bin/sh
# Any shop page loads the settings. Fires where MAX_ITEM_QUANTITY or
# FREE_SHIPPING_MIN_CENTS is unset, as on staging.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/"
