#!/bin/sh
# The order page throws a plain Error for a missing order instead of calling notFound(),
# so an unknown order id is a 500 instead of a 404.
set -eu
f='apps/demo-app/src/app/orders/[id]/page.tsx'
sed -i 's/if (!order) notFound();/if (!order) throw new Error(`No order with id ${id}`);/' "$f"
grep -q 'if (!order) throw new Error(`No order with id ${id}`);' "$f"
