#!/bin/sh
# Prices format as US dollars again.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const { formatCents } = await import('./src/shop/money.ts');
assert.equal(formatCents(2400), '$24.00');
assert.equal(formatCents(5), '$0.05');
JS
