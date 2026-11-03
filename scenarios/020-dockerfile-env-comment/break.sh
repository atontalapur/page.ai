#!/bin/sh
# The demo app image pins the free-shipping minimum with a trailing note, in the legacy
# "ENV key value" form. A Dockerfile only treats # as a comment at the start of a line,
# so the value is "5000  # free shipping from 50 USD", which coerces to NaN. Every shop
# request in the deployed image throws a ZodError; the healthcheck stays green.
set -eu
f=apps/demo-app/Dockerfile
node - "$f" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const f = process.argv[2];
const src = readFileSync(f, 'utf8');
const from = 'FROM node:24-alpine\nENV NODE_ENV=production\n';
const to =
  'FROM node:24-alpine\nENV NODE_ENV=production\n' +
  '# Same threshold everywhere the image runs, instead of each service setting it.\n' +
  'ENV FREE_SHIPPING_MIN_CENTS 5000  # free shipping from 50 USD\n';
if (!src.includes(from)) process.exit(1);
writeFileSync(f, src.replace(from, to));
JS
grep -q '^ENV FREE_SHIPPING_MIN_CENTS 5000  # free shipping from 50 USD$' "$f"
