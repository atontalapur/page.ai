#!/bin/sh
# The order page's placed date gains month: 'long' next to dateStyle, which can't be
# combined, so toLocaleDateString throws a TypeError on every order page.
set -eu
f='apps/demo-app/src/app/orders/[id]/page.tsx'
sed -i "s/toLocaleDateString('en-US', { dateStyle: 'long' })/toLocaleDateString('en-US', { dateStyle: 'medium', month: 'long' })/" "$f"
grep -q "dateStyle: 'medium', month: 'long'" "$f"
