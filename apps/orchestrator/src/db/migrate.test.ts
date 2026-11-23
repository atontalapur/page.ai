import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations } from '@page/db-migrations';
import type { Db } from './database.ts';
import { migrate } from './migrate.ts';
import { createBareTestDb, createTestDeps } from './test-utils.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

describe('migrate', () => {
  it('loads every migration in order', async () => {
    const names = (await loadMigrations()).map((m) => m.name);
    expect(names[0]).toBe('001_issues.sql');
    expect(names).toEqual([...names].sort());
  });

  it('skips migrations that already ran', async () => {
    expect(await migrate(deps.db, await loadMigrations())).toEqual([]);
    const rows = await deps.db.selectFrom('schema_migrations').select('name').execute();
    expect(rows.map((r) => r.name)).toContain('001_issues.sql');
  });

  it('applies new migrations and rolls back a failing one', async () => {
    const extra = {
      name: '999_extra.sql',
      sql: 'create table extra (id int); create table extra2 (id int);',
    };
    expect(await migrate(deps.db, [extra])).toEqual(['999_extra.sql']);

    const broken = { name: '1000_broken.sql', sql: 'create table broken (id int); select nope;' };
    await expect(migrate(deps.db, [broken])).rejects.toThrow();
    const rows = await deps.db.selectFrom('schema_migrations').select('name').execute();
    expect(rows.map((r) => r.name)).not.toContain('1000_broken.sql');
  });
});

describe('007_escalation_low_confidence', () => {
  const MIGRATION = '007_escalation_low_confidence.sql';
  const note = JSON.stringify({ summary: 'x', tried: [], blocker: 'y' });

  async function escalate(db: Db, reason: string) {
    const issue = await db
      .insertInto('issues')
      .values({ fingerprint: `migrate-${randomUUID()}`, title: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const run = await db
      .insertInto('runs')
      .values({ id: randomUUID(), issue_id: issue.id, tier: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Cast, since the test also writes reasons the column's type leaves out.
    return db
      .insertInto('escalations')
      .values({ run_id: run.id, from_tier: 1, to_tier: 2, reason: reason as never, note })
      .returning('reason')
      .executeTakeFirstOrThrow();
  }

  it('lets escalations take low_confidence and keeps the rows written before it', async () => {
    const { db } = await createBareTestDb();
    try {
      const all = await loadMigrations();
      const index = all.findIndex((m) => m.name === MIGRATION);
      expect(index).toBeGreaterThan(0);
      await migrate(db, all.slice(0, index));
      await escalate(db, 'budget_exhausted');
      await expect(escalate(db, 'low_confidence')).rejects.toThrow();

      expect(await migrate(db, all)).toContain(MIGRATION);
      const kept = await db.selectFrom('escalations').select('reason').execute();
      expect(kept).toEqual([{ reason: 'budget_exhausted' }]);
      await expect(escalate(db, 'low_confidence')).resolves.toEqual({ reason: 'low_confidence' });
      await expect(escalate(db, 'unsure')).rejects.toThrow();
    } finally {
      await db.destroy();
    }
    // Applies every migration twice over, which takes seconds once tests run in parallel.
  }, 30_000);
});
