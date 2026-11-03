#!/bin/sh
# The shop settings schema goes strict so a misspelt name like MAX_ITEMS_QUANTITY fails
# loudly instead of being ignored. But it parses the whole of process.env, which always
# has PATH, NODE_ENV, DATABASE_URL and more, so every shop request throws a ZodError
# for unrecognized keys.
set -eu
f=apps/demo-app/src/config.ts
node - "$f" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const f = process.argv[2];
let src = readFileSync(f, 'utf8');
const from =
  '// The config surface the infra/config seeded bugs break.\nconst shopSchema = z.object({\n';
const to =
  '// The config surface the infra/config seeded bugs break. Strict, so a misspelt name like\n' +
  '// MAX_ITEMS_QUANTITY fails loudly instead of leaving MAX_ITEM_QUANTITY on its default.\n' +
  'const shopSchema = z.strictObject({\n';
if (!src.includes(from)) process.exit(1);
writeFileSync(f, src.replace(from, to));
JS
grep -q 'const shopSchema = z.strictObject({' "$f"
