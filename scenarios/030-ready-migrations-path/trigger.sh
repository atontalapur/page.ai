#!/bin/sh
# The readiness check break.sh adds. On a clean app the route doesn't exist (404).
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/api/health/ready"
