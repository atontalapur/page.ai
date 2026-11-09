import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The orchestrator database's migrations (ADR 0002). The orchestrator applies them at boot;
 * tests in other packages that need its tables, such as `steps`, apply them the same way.
 */
export interface Migration {
  name: string;
  sql: string;
}

export const migrationsDir = join(import.meta.dirname, '../migrations');

/** Reads `*.sql` files from `dir`, ordered by file name. */
export async function loadMigrations(dir = migrationsDir): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })),
  );
}
