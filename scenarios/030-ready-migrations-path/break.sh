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
import { join } from 'node:path';
import type { Queryable } from '../../../db/index.ts';
import { loadMigrations } from '../../../db/migrate.ts';

// The migrations this build ships with.
const MIGRATIONS_DIR = join(process.cwd(), 'apps/demo-app/migrations');

/**
 * 200 when the database answers, 503 otherwise, so Railway and compose can gate on it.
 * `ready` also needs every migration this build ships with to be applied.
 */
export async function checkHealth(db: Queryable, ready = false): Promise<Response> {
  const shipped = ready ? (await loadMigrations(MIGRATIONS_DIR)).map((m) => m.name) : [];
  try {
    await db.query('select 1');
    if (ready) {
      const { rows } = await db.query<{ name: string }>('select name from schema_migrations');
      const applied = new Set(rows.map((row) => row.name));
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
