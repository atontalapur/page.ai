#!/bin/sh
# Sets a SHIPPING_FLAT_CENTS override that passes validation but doesn't fit the int4
# shipping_cents column, and restarts the app so it applies.
set -eu
. "$(dirname "$0")/../ops.sh"
ops PUT /api/ops/config/SHIPPING_FLAT_CENTS '{"value":"2500000000"}' >/dev/null
ops_restart
