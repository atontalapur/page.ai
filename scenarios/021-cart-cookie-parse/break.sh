#!/bin/sh
# readCartId is "simplified" to z.uuid().optional().parse(). A missing cookie still reads
# as no cart, but a cookie that isn't a uuid (a stale or hand-edited one) now throws a
# ZodError, so the cart page and every cart request 500 for that shopper.
set -eu
f=apps/demo-app/src/app/cart-session.ts
sed -i '/return parsed.success ? parsed.data : undefined;/d; s/const parsed = z.uuid().safeParse(cookies.get(COOKIE)?.value);/return z.uuid().optional().parse(cookies.get(COOKIE)?.value);/' "$f"
! grep -q 'parsed.success' "$f"
grep -q 'return z.uuid().optional().parse(cookies.get(COOKIE)?.value);' "$f"
