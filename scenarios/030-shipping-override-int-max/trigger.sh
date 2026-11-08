#!/bin/sh
# Checks out one notebook, which is under the free-shipping minimum, so the order pays the
# flat fee. The bug rolls the checkout back, so a run uses no stock.
set -eu
. "$(dirname "$0")/../checkout-trigger.sh"
checkout field-notebook
