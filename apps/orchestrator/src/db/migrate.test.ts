import { afterAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from './migrate.ts';
import { createTestDeps } from './test-utils.ts';

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
