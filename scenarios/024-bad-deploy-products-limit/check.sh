#!/bin/sh
# Runs on the host against $DEMO_APP_URL. GET /api/products answers 200 with the catalogue.
set -eu
body="$(mktemp)"
status="$(curl -sS -o "$body" -w '%{http_code}' "${DEMO_APP_URL:?}/api/products")" || {
  rm -f "$body"
  exit 2
}
grep -q '"slug":"canvas-tote"' "$body" && found=yes || found=no
rm -f "$body"
printf '%s\n' "GET /api/products returned $status, catalogue found: $found"
if [ "$status" = 200 ] && [ "$found" = yes ]; then exit 0; fi
case "$status" in
  200 | 500) exit 1 ;;
  *) exit 2 ;;
esac
