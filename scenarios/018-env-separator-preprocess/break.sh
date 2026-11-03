#!/bin/sh
# A helper lets ops write amounts like 5,000 or 5_000 by stripping separators before
# parsing, but it runs String(v) on the raw value. An unset variable becomes the string
# "undefined", so the default never applies, it coerces to NaN and every shop request
# throws a ZodError wherever MAX_ITEM_QUANTITY or FREE_SHIPPING_MIN_CENTS is unset.
set -eu
f=apps/demo-app/src/config.ts
node - "$f" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const f = process.argv[2];
let src = readFileSync(f, 'utf8');
for (const [from, to] of [
  [
    '// The config surface the infra/config seeded bugs break.\n',
    '// Lets ops write amounts with separators, like 5,000 or 5_000.\n' +
      "const envInt = <T extends z.ZodType>(schema: T) =>\n" +
      "  z.preprocess((v) => String(v).replace(/[,_]/g, ''), schema);\n\n" +
      '// The config surface the infra/config seeded bugs break.\n',
  ],
  [
    '  FREE_SHIPPING_MIN_CENTS: z.coerce.number().int().min(0).default(5000),\n' +
      '  MAX_ITEM_QUANTITY: z.coerce.number().int().min(1).default(10),\n',
    '  FREE_SHIPPING_MIN_CENTS: envInt(z.coerce.number().int().min(0).default(5000)),\n' +
      '  MAX_ITEM_QUANTITY: envInt(z.coerce.number().int().min(1).default(10)),\n',
  ],
]) {
  if (!src.includes(from)) process.exit(1);
  src = src.replace(from, to);
}
writeFileSync(f, src);
JS
grep -q "z.preprocess((v) => String(v).replace" "$f"
grep -q 'MAX_ITEM_QUANTITY: envInt(' "$f"
