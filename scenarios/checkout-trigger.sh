# Sourced by the trigger.sh of 025, 028 and 029, which run on the host (see README.md).
# Not a scenario: plain files in scenarios/ are skipped.

# checkout <product slug>: puts one of the product in a fresh cart, checks the cart out
# with POST /api/orders and prints the status code.
checkout() {
  url="${DEMO_APP_URL:?}"
  jar="$(mktemp)"
  trap 'rm -f "$jar"' EXIT
  id="$(curl -sS "$url/api/products/$1" | grep -o '"id":[0-9]*' | head -n 1 | sed 's/.*://')"
  : "${id:?no $1 product}"
  curl -sSf -o /dev/null -c "$jar" -b "$jar" -H 'content-type: application/json' \
    -d "{\"productId\":$id}" "$url/api/cart/items"
  curl -sS -o /dev/null -w '%{http_code}\n' -b "$jar" -X POST "$url/api/orders"
}
