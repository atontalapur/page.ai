#!/bin/sh
# Adds a readiness check, /api/health/ready, that also wants every migration shipped with
# the app applied. It finds them at apps/demo-app/migrations under the working directory,
# which is only right from the repo root. The app runs from its own directory, so readdir
# throws ENOENT outside the try and the check is a 500. /api/health (the deploy gate)
# doesn't read the directory, so deploys still go out.
set -eu
d=apps/demo-app/src/app/api/health
grep -q '^export async function checkHealth(db: Queryable): Promise<Response> {$' "$d/health.ts"
grep -q "^    await db.query('select 1');$" "$d/health.ts"
cat > "$d/health.ts" <<'TS'
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Queryable } from '../../../db/index.ts';

// The migrations this build ships with.
const MIGRATIONS_DIR = join(process.cwd(), 'apps/demo-app/migrations');

// Postgres' undefined_table.
const UNDEFINED_TABLE = '42P01';

/**
 * 200 when the database answers, 503 otherwise, so Railway and compose can gate on it.
 * `ready` also needs every migration this build ships with to be applied.
 */
export async function checkHealth(db: Queryable, ready = false): Promise<Response> {
  const shipped = ready
    ? (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql'))
    : [];
  try {
    await db.query('select 1');
    if (ready) {
      const applied = await appliedMigrations(db);
      const pending = shipped.filter((name) => !applied.has(name));
      if (pending.length > 0) {
        return Response.json({ status: 'error', db: 'ok', pending }, { status: 503 });
      }
    }
    return Response.json({ status: 'ok', db: 'ok' });
  } catch {
    return Response.json({ status: 'error', db: 'unreachable' }, { status: 503 });
  }
}

/** Names in schema_migrations, or none on a database that was never migrated. */
async function appliedMigrations(db: Queryable): Promise<Set<string>> {
  try {
    const { rows } = await db.query<{ name: string }>('select name from schema_migrations');
    return new Set(rows.map((row) => row.name));
  } catch (err) {
    // migrate() creates the table, so it's missing until the first migration runs.
    if ((err as { code?: unknown }).code === UNDEFINED_TABLE) return new Set();
    throw err;
  }
}
TS
mkdir -p "$d/ready"
cat > "$d/ready/route.ts" <<'TS'
import { getDb } from '../../../../db/index.ts';
import { checkHealth } from '../health.ts';

// Readiness: like /api/health, and also 503 until the deploy's migrations are applied.
export function GET() {
  return checkHealth(getDb(), true);
}
TS
grep -q "const MIGRATIONS_DIR = join(process.cwd(), 'apps/demo-app/migrations');" "$d/health.ts"
grep -q 'return checkHealth(getDb(), true);' "$d/ready/route.ts"
