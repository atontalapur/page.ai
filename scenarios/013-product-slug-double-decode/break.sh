#!/bin/sh
# GET /api/products/[slug] runs decodeURIComponent on the slug "so encoded slugs match",
# but Next has already decoded route params. A slug with a literal %, like 50%-off
# (requested as 50%25-off), is decoded twice and throws URIError: URI malformed, so the
# handler returns 500 instead of 404.
set -eu
f='apps/demo-app/src/app/api/products/[slug]/route.ts'
node - "$f" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const f = process.argv[2];
const src = readFileSync(f, 'utf8');
const from = '  const { slug } = await ctx.params;\n';
const to =
  '  // Slugs can arrive percent-encoded from links built with encodeURIComponent.\n' +
  '  const slug = decodeURIComponent((await ctx.params).slug);\n';
if (!src.includes(from)) process.exit(1);
writeFileSync(f, src.replace(from, to));
JS
grep -q 'const slug = decodeURIComponent((await ctx.params).slug);' "$f"
