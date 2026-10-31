#!/bin/sh
# Any shop page loads the settings.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/"
