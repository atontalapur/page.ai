#!/bin/sh
# Checks out one mug, which is under the free-shipping minimum, so the order pays the flat
# fee. Fires only where SHIPPING_FLAT_CENTS is unset and FREE_SHIPPING_MIN_CENTS is above
# the mug's 1600 (the default 5000 is). The bug rolls the checkout back, so a run uses no
# stock.
set -eu
. "$(dirname "$0")/../checkout-trigger.sh"
checkout enamel-mug
