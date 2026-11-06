#!/bin/sh
# Runs on the host against $DEMO_APP_URL. Checking out one notebook (under the
# free-shipping minimum) succeeds and charges the default 500 cents of flat shipping.
set -eu
. "$(dirname "$0")/../checkout-trigger.sh"
flat_shipping_check field-notebook
