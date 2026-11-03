#!/bin/sh
# POST /api/orders now redirects to the new order's page instead of returning its id.
# Response.redirect needs an absolute URL, so the relative path throws a TypeError after
# the order is committed: every checkout through the API is a 500.
set -eu
f=apps/demo-app/src/app/api/orders/route.ts
sed -i 's|    return Response.json({ orderId }, { status: 201 });|    return Response.redirect(`/orders/${orderId}`, 303);|' "$f"
grep -q 'return Response.redirect(`/orders/${orderId}`, 303);' "$f"
