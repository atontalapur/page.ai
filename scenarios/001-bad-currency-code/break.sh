#!/bin/sh
# An invalid currency code makes Intl.NumberFormat throw when money.ts loads, so every
# page that shows a price returns 500.
set -eu
f=apps/demo-app/src/shop/money.ts
sed -i "s/currency: 'USD'/currency: 'US'/" "$f"
grep -q "currency: 'US'" "$f"
