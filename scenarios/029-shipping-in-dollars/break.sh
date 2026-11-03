#!/bin/sh
# The flat shipping fee goes to $4.99, written in dollars, with .int() dropped so it parses.
# Settings load and the cart shows 5 cents of shipping, but orders.shipping_cents is an
# integer column, so every checkout under the free-shipping minimum throws.
set -eu
f=apps/demo-app/src/config.ts
sed -i 's/  SHIPPING_FLAT_CENTS: z.coerce.number().int().min(0).default(500),/  SHIPPING_FLAT_CENTS: z.coerce.number().min(0).default(4.99),/' "$f"
grep -q '  SHIPPING_FLAT_CENTS: z.coerce.number().min(0).default(4.99),' "$f"
