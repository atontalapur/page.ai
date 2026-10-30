import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHealth } from '../app/api/health/health.ts';
import { fromPool } from './db.ts';
import { ensureDatabase } from './ensure-database.ts';
import { loadMigrations, migrate } from './migrate.ts';
import { products, seed } from './seed.ts';
import { migrationsDir } from './test-utils.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests');

// Own schema per run, so this suite never touches other tables in the shared database.
const schema = `demo_app_test_${randomBytes(4).toString('hex')}`;
const admin = new pg.Pool({ connectionString: url });
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const db = fromPool(pool);

beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
});

describe('demo-app database on real Postgres', () => {
  it('migrates, seeds and reports healthy', async () => {
    const migrations = await loadMigrations(migrationsDir);
    expect(await migrate(db, migrations)).toHaveLength(migrations.length);
    expect(await migrate(db, migrations)).toEqual([]);

    await seed(db);
    await seed(db);
    const { rows } = await db.query<{ count: string }>('select count(*) from products');
    expect(Number(rows[0]?.count)).toBe(products.length);

    expect((await checkHealth(db)).status).toBe(200);
  });

  it('rolls back a failed transaction', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`update products set stock = 0`);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    const { rows } = await db.query<{ stock: number }>(
      `select stock from products where slug = 'canvas-tote'`,
    );
    expect(rows[0]?.stock).toBe(40);
  });

  it('creates a missing database once', async () => {
    const name = `demo_app_test_${randomBytes(4).toString('hex')}`;
    const target = new URL(url);
    target.pathname = `/${name}`;
    try {
      expect(await ensureDatabase(target.toString())).toBe(true);
      expect(await ensureDatabase(target.toString())).toBe(false);
    } finally {
      await admin.query(`drop database if exists ${name}`);
    }
  });
});
