#!/bin/sh
# Any shop page loads the settings. Fires on an app deployed from apps/demo-app/Dockerfile
# (staging on Railway), not on `next dev`.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/"
