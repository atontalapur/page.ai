#!/bin/sh
# An empty cart is mapped to 204 No Content ("there's nothing to order"). errorResponse
# always sends a JSON body, and a 204 can't have one, so Response.json throws a TypeError
# and checking out an empty cart is a 500 instead of a 409.
set -eu
f=apps/demo-app/src/app/api/respond.ts
sed -i 's/  empty_cart: 409,/  empty_cart: 204,/' "$f"
grep -q '  empty_cart: 204,' "$f"
