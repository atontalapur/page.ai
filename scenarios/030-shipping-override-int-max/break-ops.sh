#!/bin/sh
# Sets SHIPPING_FLAT_CENTS to the int4 maximum. It passes validation and fits the
# shipping_cents column, but any subtotal on top of it overflows total_cents. Restarts the
# app so it applies.
set -eu
. "$(dirname "$0")/../ops.sh"
ops PUT /api/ops/config/SHIPPING_FLAT_CENTS '{"value":"2147483647"}' >/dev/null
ops_restart
