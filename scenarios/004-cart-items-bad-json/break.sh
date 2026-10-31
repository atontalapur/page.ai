#!/bin/sh
# The cart items handler no longer catches a body that isn't JSON, so a malformed
# request throws a SyntaxError (500) instead of getting a 400.
set -eu
f=apps/demo-app/src/app/api/cart/items/route.ts
sed -i 's/await req.json().catch(() => undefined)/await req.json()/' "$f"
grep -q 'body.safeParse(await req.json())' "$f"
