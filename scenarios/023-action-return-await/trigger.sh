#!/bin/sh
# Submits the product page's add-to-cart form the way a browser without JavaScript does,
# asking for more than the per-item limit. The action id comes from the rendered form.
set -eu
url="${DEMO_APP_URL:?}"
page="$url/products/canvas-tote"
html="$(curl -sS "$page")"
# printf, not echo: dash's echo expands the backslashes in the RSC payload. grep -o and
# head take the first form on the page, which Next renders on one line.
action="$(printf '%s\n' "$html" | grep -o 'name="\$ACTION_ID_[0-9a-f]*"' | head -n 1 |
  sed 's/.*_\([0-9a-f]*\)"$/\1/')"
id="$(printf '%s\n' "$html" | grep -o 'name="productId" value="[0-9]*"' | head -n 1 |
  sed 's/.*value="\([0-9]*\)"$/\1/')"
: "${action:?no add-to-cart form}" "${id:?no product id}"
curl -sS -o /dev/null -w '%{http_code}\n' -F "\$ACTION_ID_$action=" -F "productId=$id" \
  -F 'quantity=999' "$page"
