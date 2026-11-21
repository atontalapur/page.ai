import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { liveAppLock } from './ops-lock.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests');

const logger = pino({ enabled: false });
const pool = new pg.Pool({ connectionString: url });
const other = new pg.Pool({ connectionString: url });
afterAll(async () => {
  await pool.end();
  await other.end();
});

describe('liveAppLock on real Postgres', () => {
  it('lets one daemon at a time hold the app', async () => {
    const app = `https://${randomUUID()}.example.com`;
    // Another daemon's session holding the advisory lock on the same app.
    const held = await other.connect();
    try {
      await held.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`page-ops:${app}`]);
      expect(await liveAppLock(pool, app, logger).tryAcquire()).toBeNull();

      await held.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`page-ops:${app}`]);
      const release = await liveAppLock(pool, app, logger).tryAcquire();
      expect(release).toBeTypeOf('function');
      const { rows } = await held.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [`page-ops:${app}`],
      );
      expect(rows[0]?.locked).toBe(false);

      await release?.();
      const after = await held.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [`page-ops:${app}`],
      );
      expect(after.rows[0]?.locked).toBe(true);
    } finally {
      held.release(true);
    }
  });
});
