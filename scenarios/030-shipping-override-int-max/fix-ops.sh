#!/bin/sh
# Drops the override, so the default flat shipping applies again, and restarts the app.
set -eu
. "$(dirname "$0")/../ops.sh"
ops DELETE /api/ops/config/SHIPPING_FLAT_CENTS >/dev/null
ops_restart
