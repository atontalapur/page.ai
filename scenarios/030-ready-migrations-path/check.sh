#!/bin/sh
# Run from the app's directory, as the app is, the health check answers 200 on a migrated
# database, ready or not, and 503 when the database is down.
set -eu
cd apps/demo-app
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
const { checkHealth } = await import('./src/app/api/health/health.ts');

const names = (await readdir('migrations')).filter((name) => name.endsWith('.sql'));
const db = {
  query: async (text) => ({
    rows: text.includes('schema_migrations') ? names.map((name) => ({ name })) : [{}],
  }),
  exec: async () => {},
};
const down = {
  query: () => Promise.reject(new Error('ECONNREFUSED')),
  exec: () => Promise.reject(new Error('ECONNREFUSED')),
};
for (const ready of [false, true]) {
  const ok = await checkHealth(db, ready);
  assert.equal(ok.status, 200, `ready=${ready}`);
  assert.equal((await ok.json()).status, 'ok');
  assert.equal((await checkHealth(down, ready)).status, 503, `ready=${ready}`);
}
JS
