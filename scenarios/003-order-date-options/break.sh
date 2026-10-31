#!/bin/sh
# The order page shows when the order was placed, but dateStyle can't be combined with
# month, so toLocaleDateString throws a TypeError on every order page.
set -eu
f='apps/demo-app/src/app/orders/[id]/page.tsx'
sed -i "s|^      <p>Status: {order.status}</p>\$|&\n      <p>\n        Placed{' '}\n        {order.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium', month: 'long' })}\n      </p>|" "$f"
grep -q "dateStyle: 'medium', month: 'long'" "$f"
