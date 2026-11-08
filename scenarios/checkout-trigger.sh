# Sourced by the trigger.sh of 025, 028, 029 and 030 and the check.sh of 029 and 030, which
# run on the host (see README.md).
# Not a scenario: plain files in scenarios/ are skipped.

# checkout <product slug>: puts one of the product in a fresh cart, checks the cart out
# with POST /api/orders and prints the status code. With CHECKOUT_CART set to a file path,
# the cart as it was before checkout (the add-to-cart response) is saved there.
checkout() {
  url="${DEMO_APP_URL:?}"
  jar="$(mktemp)"
  trap 'rm -f "$jar"' EXIT
  id="$(curl -sS "$url/api/products/$1" | grep -o '"id":[0-9]*' | head -n 1 | sed 's/.*://')"
  : "${id:?no $1 product}"
  curl -sSf -o "${CHECKOUT_CART:-/dev/null}" -c "$jar" -b "$jar" -H 'content-type: application/json' \
    -d "{\"productId\":$id}" "$url/api/cart/items"
  curl -sS -o /dev/null -w '%{http_code}\n' -b "$jar" -X POST "$url/api/orders"
}

# flat_shipping_check <product slug>: exits 0 when checking out one of a product under the
# free-shipping minimum succeeds and charged the default flat 500 cents, 1 when checkout
# fails with a 500 or charged anything else, and 2 for any other answer.
flat_shipping_check() {
  cart="$(mktemp)"
  status="$(CHECKOUT_CART="$cart" checkout "$1")" || { rm -f "$cart"; exit 2; }
  shipping="$(grep -o '"shippingCents":[0-9]*' "$cart" | sed 's/.*://')" || true
  rm -f "$cart"
  printf '%s\n' "checkout returned $status, cart shipping ${shipping:-unknown} cents"
  if [ "$status" = 201 ] && [ "$shipping" = 500 ]; then exit 0; fi
  case "$status" in
    201 | 500) exit 1 ;;
    *) exit 2 ;;
  esac
}
