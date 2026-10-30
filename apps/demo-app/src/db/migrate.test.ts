import { describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from './migrate.ts';
import { createTestDb, migrationsDir } from './test-utils.ts';

describe('migrate', () => {
  it('applies every migration once', async () => {
    const db = await createTestDb({ migrated: false });
    const migrations = await loadMigrations(migrationsDir);

    expect(await migrate(db, migrations)).toEqual(migrations.map((m) => m.name));
    expect(await migrate(db, migrations)).toEqual([]);
  });

  it('rolls back a failing migration and records nothing', async () => {
    const db = await createTestDb({ migrated: false });
    const bad = [
      { name: '001_ok.sql', sql: 'create table a (id int)' },
      { name: '002_bad.sql', sql: 'create table oops (' },
    ];

    await expect(migrate(db, bad)).rejects.toThrow();
    const { rows } = await db.query(`select to_regclass('a') as t`);
    expect(rows[0]).toEqual({ t: null });
  });

  it('loads only .sql files in name order', async () => {
    const names = (await loadMigrations(migrationsDir)).map((m) => m.name);
    expect(names).toEqual([...names].sort());
    expect(names.every((n) => n.endsWith('.sql'))).toBe(true);
  });
});
