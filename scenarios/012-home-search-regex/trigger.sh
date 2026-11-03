#!/bin/sh
# Searches for "(", an unterminated regex group.
set -eu
curl -sS -o /dev/null -w '%{http_code}\n' "${DEMO_APP_URL:?}/?q=%28"
