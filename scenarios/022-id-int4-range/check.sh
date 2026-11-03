#!/bin/sh
# Ids parse only within a positive Postgres int4.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const { idSchema, parseId } = await import('./src/app/ids.ts');
assert.equal(parseId('7'), 7);
assert.equal(parseId('2147483647'), 2147483647);
assert.equal(parseId('2147483648'), undefined);
assert.equal(parseId('3000000000'), undefined);
assert.equal(parseId('0'), undefined);
assert.equal(parseId('abc'), undefined);
assert.equal(idSchema.safeParse(2147483648).success, false);
assert.equal(idSchema.safeParse(1).success, true);
JS
