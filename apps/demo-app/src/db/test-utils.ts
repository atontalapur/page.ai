import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import pg from 'pg';
import { onTestFinished } from 'vitest';
import { fromPool, type Db, type Queryable } from './db.ts';
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

function toDb(pg: PGlite): Db {
  return { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))) };
}

// PGlite runs initdb on every create, which takes over 2 s on the sandbox's one CPU.
// Each test file runs it once per variant and loads a copy of the data dir instead.
const snapshots = new Map<boolean, Promise<Blob>>();

function snapshot(migrated: boolean): Promise<Blob> {
  let blob = snapshots.get(migrated);
  if (!blob) {
    blob = (async () => {
      const pg = await PGlite.create();
      try {
        if (migrated) await migrate(toDb(pg), await loadMigrations(migrationsDir));
        return await pg.dumpDataDir('none');
      } finally {
        await pg.close();
      }
    })();
    snapshots.set(migrated, blob);
  }
  return blob;
}

/**
 * In-memory Postgres, so unit tests run with no network. Each call gets its own copy.
 * Closed when the test ends: each instance holds a few hundred MB, and the 1 GB agent
 * sandbox (#5) can't keep one per test alive.
 */
export async function createTestDb({ migrated = true } = {}): Promise<Db> {
  const pg = await PGlite.create({ loadDataDir: await snapshot(migrated) });
  onTestFinished(() => pg.close());
  return toDb(pg);
}

/**
 * A pool on the real Postgres at DATABASE_URL, confined to a throwaway schema so
 * integration tests never touch other tables in a shared database.
 */
export async function createSchemaDb({ migrated = true } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for integration tests');

  const schema = `demo_app_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const db = fromPool(pool);
  if (migrated) await migrate(db, await loadMigrations(migrationsDir));

  return {
    db,
    url,
    admin,
    close: async () => {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}
