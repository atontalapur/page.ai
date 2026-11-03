#!/bin/sh
# orShowError loses the await on `return await work()`. The promise is returned before it
# settles, so a ShopError rejects outside the try/catch: adding more than the limit or
# checking out an empty cart is a 500 instead of a redirect to the cart with a message.
set -eu
f=apps/demo-app/src/app/actions.ts
sed -i 's/    return await work();/    return work();/' "$f"
grep -q '^    return work();$' "$f"
