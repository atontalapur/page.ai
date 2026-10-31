import pg from 'pg';
import { databaseUrl } from '../config.ts';
import { fromPool, type Db } from './db.ts';

export type { Db, Queryable } from './db.ts';

// Next dev reloads modules on every edit; keep one pool per process.
const cache = globalThis as { demoAppDb?: Db };

export function getDb(): Db {
  cache.demoAppDb ??= fromPool(new pg.Pool({ connectionString: databaseUrl() }));
  return cache.demoAppDb;
}
