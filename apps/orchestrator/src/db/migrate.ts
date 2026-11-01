import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Db } from './database.ts';

export interface Migration {
  name: string;
  sql: string;
}

export const migrationsDir = join(import.meta.dirname, '../../migrations');

/** Reads `*.sql` files from `dir`, ordered by file name. */
export async function loadMigrations(dir = migrationsDir): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })),
  );
}

/** Applies pending migrations in one transaction and returns the names it applied. */
export async function migrate(db: Db, migrations: Migration[]): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    // Serialises concurrent boots; the lock is released at commit.
    await sql`select pg_advisory_xact_lock(hashtext('orchestrator:migrate'))`.execute(trx);
    await sql`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`.execute(trx);
    const rows = await trx.selectFrom('schema_migrations').select('name').execute();
    const applied = new Set(rows.map((row) => row.name));

    const pending = migrations.filter((m) => !applied.has(m.name));
    for (const m of pending) {
      // No parameters, so node-postgres uses the simple protocol and a file may hold
      // several statements.
      await sql.raw(m.sql).execute(trx);
      await trx.insertInto('schema_migrations').values({ name: m.name }).execute();
    }
    return pending.map((m) => m.name);
  });
}
