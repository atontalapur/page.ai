import type { Migration } from '@page/db-migrations';
import { sql } from 'kysely';
import type { Db } from './database.ts';

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
