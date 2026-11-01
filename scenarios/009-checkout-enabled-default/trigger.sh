#!/bin/sh
# Any shop page loads the settings. Fires only where CHECKOUT_ENABLED is unset.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/"
