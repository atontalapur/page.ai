#!/bin/sh
# CHECKOUT_ENABLED loses its default. Where it isn't set (staging), every shop request
# fails to parse the settings and throws a ZodError. The healthcheck stays green.
set -eu
f=apps/demo-app/src/config.ts
sed -i 's/CHECKOUT_ENABLED: z.stringbool().default(true),/CHECKOUT_ENABLED: z.stringbool(),/' "$f"
grep -q 'CHECKOUT_ENABLED: z.stringbool(),' "$f"
