import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, PostgresDialect } from 'kysely';
import pg from 'pg';
import { fromPglite, PgBoss } from 'pg-boss';
import { loadMigrations } from '@page/db-migrations';
import { pino } from 'pino';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { FakePager, type Pager } from '../notify/pager.ts';
import { createFixJobQueue, type FixJobQueue } from '../queue/fix-jobs.ts';
import { createJobQueues, type JobQueues } from '../queue/queues.ts';
import { TriageClassifier } from '../triage/classify.ts';
import type { Database, Db } from './database.ts';
import { migrate } from './migrate.ts';

export const testConfig: Config = {
  databaseUrl: 'postgres://page:page@localhost:5432/page',
  port: 4000,
  host: '0.0.0.0',
  pgbossSchema: 'pgboss',
  useFakeAdapters: true,
  logLevel: 'info',
  posthogWebhookSecret: 'test-webhook-secret',
  openRouterApiKey: undefined,
  triageModel: 'openai/gpt-4o-mini',
  triageTimeoutMs: 8_000,
  twilio: undefined,
  notifyTo: ['+15550000001'],
  dashboardUrl: 'http://localhost:3000',
};

export interface TestDeps {
  db: Db;
  boss: PgBoss;
  fixJobs: FixJobQueue;
  jobs: JobQueues;
  /** Silent, so test output stays clean. */
  logger: Logger;
  config: Config;
  pager: Pager;
  classifier: TriageClassifier;
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

/**
 * Migrates and starts pg-boss, and runs `close` if either fails. pg-boss reports background
 * errors as events, which a throwing listener would turn into an uncaught exception that
 * kills the test worker, so they are collected and thrown from close() instead.
 */
async function start(db: Db, boss: PgBoss, close: () => Promise<void>): Promise<TestDeps> {
  const errors: unknown[] = [];
  boss.on('error', (err) => errors.push(err));
  try {
    await migrate(db, await loadMigrations());
    await boss.start();
    const fixJobs = await createFixJobQueue(boss);
    const jobs = await createJobQueues(boss);
    return {
      db,
      boss,
      fixJobs,
      jobs,
      logger: pino({ enabled: false }),
      config: testConfig,
      pager: new FakePager(),
      classifier: new TriageClassifier(null, testConfig.triageTimeoutMs),
      async close() {
        await close();
        if (errors.length) throw new AggregateError(errors, 'pg-boss reported errors');
      },
    };
  } catch (err) {
    await close().catch(() => undefined);
    throw err;
  }
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
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const boss = new PgBoss({ connectionString: url, schema: bossSchema });
  // Runs every step even if one fails, so a broken run still drops its schemas.
  const close = async () => {
    const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([
      boss.stop({ graceful: false }),
      db.destroy(),
    ]);
    results.push(
      ...(await Promise.allSettled([
        admin.query(`drop schema if exists ${schema} cascade`),
        admin.query(`drop schema if exists ${bossSchema} cascade`),
      ])),
    );
    await admin.end();
    const failed = results.flatMap((r): unknown[] => (r.status === 'rejected' ? [r.reason] : []));
    if (failed.length) throw new AggregateError(failed, 'test schema cleanup failed');
  };

  try {
    await admin.query(`create schema ${schema}`);
  } catch (err) {
    await close().catch(() => undefined);
    throw err;
  }
  const deps = await start(db, boss, close);
  return { ...deps, url };
}
