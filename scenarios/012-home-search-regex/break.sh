#!/bin/sh
# The home page gains a search box that filters products with new RegExp(q). A query
# with a regex metacharacter, like "(" or "[", is an invalid pattern, so the RegExp
# constructor throws a SyntaxError and the home page returns 500.
set -eu
d=apps/demo-app/src/app
node - "$d/page.tsx" "$d/pages.test.tsx" <<'JS'
const { readFileSync, writeFileSync } = require('node:fs');
const edit = (f, pairs) => {
  let src = readFileSync(f, 'utf8');
  for (const [from, to] of pairs) {
    if (!src.includes(from)) process.exit(1);
    src = src.replace(from, to);
  }
  writeFileSync(f, src);
};
edit(process.argv[2], [
  [
    'export default async function HomePage() {\n  const { db } = await shop();\n  const products = await listProducts(db);\n',
    'export default async function HomePage(props: PageProps<\'/\'>) {\n' +
      '  const { q } = await props.searchParams;\n' +
      '  const query = typeof q === \'string\' ? q.trim() : \'\';\n' +
      '  const { db } = await shop();\n' +
      '  const all = await listProducts(db);\n' +
      '  const products = query ? all.filter((p) => new RegExp(query, \'i\').test(p.name)) : all;\n',
  ],
  [
    '      <h1>Products</h1>\n',
    '      <h1>Products</h1>\n' +
      '      <form>\n' +
      '        <input type="search" name="q" defaultValue={query} placeholder="Search" />\n' +
      '      </form>\n',
  ],
]);
edit(process.argv[3], [['await HomePage()', 'await HomePage(props({}))']]);
JS
grep -q "new RegExp(query, 'i')" "$d/page.tsx"
grep -q 'await HomePage(props({}))' "$d/pages.test.tsx"
