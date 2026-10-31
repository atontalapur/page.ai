import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import pg from 'pg';
import { inject, onTestFinished } from 'vitest';
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

declare module 'vitest' {
  export interface ProvidedContext {
    pgliteSnapshotDir: string;
  }
}

function snapshotFile(dir: string, migrated: boolean): string {
  return join(dir, migrated ? 'migrated.tar' : 'fresh.tar');
}

/**
 * PGlite runs initdb on every create, which takes over 2 s on the sandbox's one CPU.
 * vitest.global-setup.ts calls this once per run (via scripts/pglite-snapshot.ts) to
 * save a fresh and a migrated data dir, and each test loads a copy.
 */
export async function writeSnapshots(dir: string): Promise<void> {
  const pg = await PGlite.create();
  try {
    const save = async (migrated: boolean) => {
      const blob = await pg.dumpDataDir('none');
      await writeFile(snapshotFile(dir, migrated), Buffer.from(await blob.arrayBuffer()));
    };
    await save(false);
    await migrate(toDb(pg), await loadMigrations(migrationsDir));
    await save(true);
  } finally {
    await pg.close();
  }
}

// Read once per test file. A failed read is dropped so the next test reports its own
// error instead of replaying this one.
const snapshots = new Map<boolean, Promise<Blob>>();

function snapshot(migrated: boolean): Promise<Blob> {
  let blob = snapshots.get(migrated);
  if (!blob) {
    blob = readFile(snapshotFile(inject('pgliteSnapshotDir'), migrated)).then(
      (data) => new Blob([data]),
    );
    blob.catch(() => snapshots.delete(migrated));
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
