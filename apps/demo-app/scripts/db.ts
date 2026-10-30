// Usage: node scripts/db.ts <migrate|seed>. Reads DATABASE_URL from the environment.
import { join } from 'node:path';
import pg from 'pg';
import { databaseUrl } from '../src/config.ts';
import { fromPool } from '../src/db/db.ts';
import { ensureDatabase } from '../src/db/ensure-database.ts';
import { loadMigrations, migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';

const command = process.argv[2];
if (command !== 'migrate' && command !== 'seed') {
  console.error('usage: node scripts/db.ts <migrate|seed>');
  process.exit(2);
}

const DATABASE_URL = databaseUrl();
if (command === 'migrate' && (await ensureDatabase(DATABASE_URL))) {
  console.log('created database');
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  const db = fromPool(pool);
  if (command === 'migrate') {
    const applied = await migrate(
      db,
      await loadMigrations(join(import.meta.dirname, '../migrations')),
    );
    console.log(applied.length ? `applied ${applied.join(', ')}` : 'migrations up to date');
  } else {
    await seed(db);
    console.log('seeded products');
  }
} finally {
  await pool.end();
}
