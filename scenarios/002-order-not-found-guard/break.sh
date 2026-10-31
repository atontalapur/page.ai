#!/bin/sh
# getOrder returns null for a missing order, but the page now only checks for undefined,
# so an unknown order id reaches order.id and throws instead of returning a 404.
set -eu
f='apps/demo-app/src/app/orders/[id]/page.tsx'
sed -i 's/if (!order) notFound();/if (order === undefined) notFound();/' "$f"
grep -q 'if (order === undefined) notFound();' "$f"
