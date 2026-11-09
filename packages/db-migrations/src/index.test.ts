import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations } from './index.ts';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('loadMigrations', () => {
  it('loads the repo migrations in file-name order', async () => {
    const names = (await loadMigrations()).map((m) => m.name);
    expect(names.slice(0, 2)).toEqual(['001_issues.sql', '002_runs.sql']);
    expect(names).toEqual([...names].sort());
  });

  it('reads only .sql files, sorted by name, with their contents', async () => {
    dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    await writeFile(join(dir, '010_b.sql'), 'select 2;');
    await writeFile(join(dir, '002_a.sql'), 'select 1;');
    await writeFile(join(dir, 'README.md'), '# not a migration');
    expect(await loadMigrations(dir)).toEqual([
      { name: '002_a.sql', sql: 'select 1;' },
      { name: '010_b.sql', sql: 'select 2;' },
    ]);
  });
});
