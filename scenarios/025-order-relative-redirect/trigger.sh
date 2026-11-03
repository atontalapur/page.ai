#!/bin/sh
# Checks out a fresh cart with one notebook in it. The order commits before the redirect
# throws, so each run uses up a field notebook (028 needs them too); reseeding resets the
# stock.
set -eu
. "$(dirname "$0")/../checkout-trigger.sh"
checkout field-notebook
