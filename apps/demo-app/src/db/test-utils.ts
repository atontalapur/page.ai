import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db, Queryable } from './db.ts';
import { loadMigrations, migrate } from './migrate.ts';

export const migrationsDir = join(import.meta.dirname, '../../migrations');

function wrap(client: PGlite | Transaction): Queryable {
  return {
    query: (text, params) => client.query(text, params),
    exec: async (text) => {
      await client.exec(text);
    },
  };
}

/** In-memory Postgres, so unit tests run with no network. */
export async function createTestDb({ migrated = true } = {}): Promise<Db> {
  const pg = await PGlite.create();
  const db: Db = { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };
  if (migrated) await migrate(db, await loadMigrations(migrationsDir));
  return db;
}
