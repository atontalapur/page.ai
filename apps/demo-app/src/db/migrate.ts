import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.ts';

export interface Migration {
  name: string;
  sql: string;
}

/** Reads `*.sql` files from `dir`, ordered by file name. */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })),
  );
}

/** Applies pending migrations in one transaction and returns the names it applied. */
export async function migrate(db: Db, migrations: Migration[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    // Serialises concurrent deploys; the lock is released at commit.
    await tx.query(`select pg_advisory_xact_lock(hashtext('demo-app:migrate'))`);
    await tx.exec(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
    const { rows } = await tx.query<{ name: string }>('select name from schema_migrations');
    const applied = new Set(rows.map((row) => row.name));

    const pending = migrations.filter((m) => !applied.has(m.name));
    for (const m of pending) {
      await tx.exec(m.sql);
      await tx.query('insert into schema_migrations (name) values ($1)', [m.name]);
    }
    return pending.map((m) => m.name);
  });
}
