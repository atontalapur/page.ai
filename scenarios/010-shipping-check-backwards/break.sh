#!/bin/sh
# A new settings check is meant to reject a free-shipping minimum at or below the flat
# fee (0 still means free shipping on everything), but the comparison is backwards, so
# the defaults fail and every shop page throws.
set -eu
f=apps/demo-app/src/config.ts
node - "$f" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const f = process.argv[2];
const before = readFileSync(f, 'utf8');
const end = "  CHECKOUT_ENABLED: z.stringbool().default(true),\n});\n";
if (!before.includes(end)) process.exit(1);
writeFileSync(
  f,
  before.replace(
    end,
    "  CHECKOUT_ENABLED: z.stringbool().default(true),\n" +
      "}).refine((c) => c.FREE_SHIPPING_MIN_CENTS === 0 || c.SHIPPING_FLAT_CENTS > c.FREE_SHIPPING_MIN_CENTS, {\n" +
      "  message: 'FREE_SHIPPING_MIN_CENTS must be 0 or above SHIPPING_FLAT_CENTS',\n" +
      "});\n",
  ),
);
JS
grep -q 'c.SHIPPING_FLAT_CENTS > c.FREE_SHIPPING_MIN_CENTS' "$f"
