import { liveAppKey, liveAppLockDir, tryLockLiveApp } from '@page/toolkit';
import type pg from 'pg';
import type { Logger } from 'pino';

/** Releases a claim on the live app. Never rejects. */
export type ReleaseOps = () => Promise<void>;

/**
 * A claim on the live demo app, held for one Tier 3 run so no other run or eval changes and
 * restarts the app under it.
 */
export interface OpsLock {
  /** Resolves a release once the app is claimed, or null while someone else holds it. */
  tryAcquire(): Promise<ReleaseOps | null>;
}

/**
 * Claims the app at `url` twice: a Postgres advisory lock, which daemons sharing the
 * database see wherever they run, and the eval's lock directory, which `pnpm eval:run` on
 * this machine sees. The advisory lock is held on one pooled connection for the run, and
 * Postgres drops it if that connection dies. An eval on another machine isn't covered.
 */
export function liveAppLock(pool: pg.Pool, url: string, logger: Logger): OpsLock {
  const key = `page-ops:${liveAppKey(url)}`;
  return {
    async tryAcquire() {
      const releaseDir = tryLockLiveApp(url);
      if (releaseDir === null) {
        logger.warn(
          { lockDir: liveAppLockDir(url) },
          'an eval or another run on this machine holds the live app. If none does, remove ' +
            'the lock directory',
        );
        return null;
      }
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        releaseDir();
        throw error;
      }
      // The pool's error handler covers idle clients only. This one sits idle for the run,
      // and an error event with no listener would crash the daemon. Losing the connection
      // loses the lock, which the release below then can't drop: it just lets the client go.
      const onError = (error: Error) => {
        logger.error({ err: error }, 'lost the connection holding the live app lock');
      };
      client.on('error', onError);
      const letGo = (error?: Error) => {
        client.off('error', onError);
        client.release(error);
      };
      try {
        const { rows } = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
          [key],
        );
        if (rows[0]?.locked !== true) {
          letGo();
          releaseDir();
          return null;
        }
      } catch (error) {
        letGo(error as Error);
        releaseDir();
        throw error;
      }
      return async () => {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
          letGo();
        } catch (error) {
          // Dropping the connection drops the lock with it.
          letGo(error as Error);
        } finally {
          releaseDir();
        }
      };
    },
  };
}
