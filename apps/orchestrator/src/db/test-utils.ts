import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, PostgresDialect } from 'kysely';
import pg from 'pg';
import { fromPglite, PgBoss } from 'pg-boss';
import { createFixJobQueue, type FixJobQueue } from '../queue/fix-jobs.ts';
import type { Database, Db } from './database.ts';
import { loadMigrations, migrate } from './migrate.ts';

export interface TestDeps {
  db: Db;
  boss: PgBoss;
  fixJobs: FixJobQueue;
  close(): Promise<void>;
}

type Query = PGlite['query'];

/**
 * node-postgres sends a query with no parameters over the simple protocol, which allows
 * several statements (migration files rely on it). PGlite's query() never does, so send
 * those through exec() instead.
 */
function simpleWhenNoParams(target: Pick<PGlite, 'query' | 'exec'>): Query {
  return (async (text: string, params?: unknown[], options?: Parameters<Query>[2]) => {
    if (params?.length) return target.query(text, params, options);
    const results = await target.exec(text, options);
    return results.at(-1) ?? { rows: [], fields: [] };
  }) as Query;
}

async function start(db: Db, boss: PgBoss, close: () => Promise<void>): Promise<TestDeps> {
  await migrate(db, await loadMigrations());
  boss.on('error', (err) => {
    throw err;
  });
  await boss.start();
  return { db, boss, fixJobs: await createFixJobQueue(boss), close };
}

/** In-memory Postgres with migrations and pg-boss installed, so unit tests need no network. */
export async function createTestDeps(): Promise<TestDeps> {
  const pglite = await PGlite.create();
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({
      pglite: {
        get closed() {
          return pglite.closed;
        },
        get ready() {
          return pglite.ready;
        },
        get waitReady() {
          return pglite.waitReady;
        },
        close: () => pglite.close(),
        query: simpleWhenNoParams(pglite),
        transaction: (fn) =>
          pglite.transaction((tx) =>
            fn({ query: simpleWhenNoParams(tx), rollback: () => tx.rollback() }),
          ),
      },
    }),
  });
  const boss = new PgBoss({
    db: fromPglite(pglite),
    backend: 'pglite',
    supervise: false,
    schedule: false,
  });
  return start(db, boss, async () => {
    await boss.stop({ graceful: false });
    await db.destroy();
  });
}

/**
 * The real Postgres at DATABASE_URL, confined to throwaway schemas for the issue tables
 * and pg-boss, so integration tests never touch other tables in a shared database.
 */
export async function createSchemaDeps(): Promise<TestDeps & { url: string }> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for integration tests');

  const suffix = randomBytes(4).toString('hex');
  const schema = `orchestrator_test_${suffix}`;
  const bossSchema = `pgboss_test_${suffix}`;
  const admin = new pg.Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const boss = new PgBoss({ connectionString: url, schema: bossSchema });

  const deps = await start(db, boss, async () => {
    await boss.stop({ graceful: false });
    await db.destroy();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.query(`drop schema if exists ${bossSchema} cascade`);
    await admin.end();
  });
  return { ...deps, url };
}
