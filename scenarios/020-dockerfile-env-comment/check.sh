#!/bin/sh
# The shop settings baked into the demo app image's runtime stage parse. ENV lines are
# read the way Docker reads them: in "ENV key value" form the value is the rest of the
# line, # included.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { loadShopSettings } = await import('./src/config.ts');

const lines = readFileSync('Dockerfile', 'utf8').replace(/\\\n/g, ' ').split('\n');
const stages = [];
for (const line of lines) {
  if (/^\s*FROM\s/i.test(line)) stages.push([]);
  else if (stages.length) stages.at(-1).push(line);
}
assert.ok(stages.length > 0, 'no FROM in the Dockerfile');

const env = {};
const unquote = (v) => v.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
for (const line of stages.at(-1)) {
  const m = /^\s*ENV\s+(.*)$/i.exec(line);
  if (!m) continue;
  const rest = m[1].trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
    for (const p of rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)) {
      env[p[1]] = unquote(p[2]);
    }
  } else {
    const [, key, value] = /^(\S+)\s+(.*)$/s.exec(rest) ?? [];
    if (key) env[key] = unquote(value.trim());
  }
}

const settings = loadShopSettings(env);
assert.ok(Number.isInteger(settings.freeShippingMinCents));
assert.ok(Number.isInteger(settings.maxItemQuantity));
JS
