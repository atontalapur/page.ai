#!/bin/sh
# Checks out a fresh cart with one notebook in it. The bug rolls the checkout back, so a
# run uses no stock, but it needs a notebook in stock and 025's runs use them up;
# reseeding resets the stock.
set -eu
. "$(dirname "$0")/../checkout-trigger.sh"
checkout field-notebook
