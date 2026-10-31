#!/bin/sh
# placeOrder no longer re-checks stock ("addItem already does"). Two carts can each hold
# what's in stock, and the second checkout's decrement violates products_stock_check.
set -eu
f=apps/demo-app/src/shop/orders.ts
sed -i '/const short = lines.find/d; /if (short) throw/d' "$f"
! grep -q 'short' "$f"
