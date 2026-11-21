import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { liveAppLockDir } from '@page/toolkit';
import type pg from 'pg';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { liveAppLock } from './ops-lock.ts';

/** A pool whose one client answers the advisory lock calls with `locked`. */
function fakePool({ locked = true, unlockFails = false, connectFails = false } = {}) {
  const queries: string[] = [];
  const released: (Error | undefined)[] = [];
  const listeners = new Set<(error: Error) => void>();
  const client = {
    on: (_: 'error', listener: (error: Error) => void) => void listeners.add(listener),
    off: (_: 'error', listener: (error: Error) => void) => void listeners.delete(listener),
    query: (sql: string) => {
      queries.push(sql);
      if (sql.includes('pg_advisory_unlock') && unlockFails) {
        return Promise.reject(new Error('connection lost'));
      }
      return Promise.resolve({ rows: [{ locked }] });
    },
    release: (error?: Error) => void released.push(error),
  };
  const pool = {
    connect: () =>
      connectFails ? Promise.reject(new Error('database is down')) : Promise.resolve(client),
  } as unknown as pg.Pool;
  return { pool, queries, released, listeners };
}

/** A logger that keeps what it logged. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    {},
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines };
}

// A URL per test, so each has its own lock directory.
const appUrl = () => `https://${randomUUID()}.example.com`;

describe('liveAppLock', () => {
  it('holds the advisory lock and the lock directory until released', async () => {
    const url = appUrl();
    const { logger, lines } = capture();
    const { pool, queries, released, listeners } = fakePool();
    const release = await liveAppLock(pool, url, logger).tryAcquire();

    expect(release).toBeTypeOf('function');
    expect(queries).toEqual(['SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked']);
    expect(existsSync(liveAppLockDir(url))).toBe(true);
    // Another claim on this machine sees the directory, says where it is, and doesn't
    // reach Postgres.
    expect(await liveAppLock(pool, url, logger).tryAcquire()).toBeNull();
    expect(queries).toHaveLength(1);
    expect(lines).toMatchObject([{ level: 40, lockDir: liveAppLockDir(url) }]);

    // The held connection dropping is logged, not thrown as an unhandled error event.
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener(new Error('terminating connection'));
    expect(lines[1]).toMatchObject({
      level: 50,
      msg: 'lost the connection holding the live app lock',
    });

    await release?.();
    expect(queries[1]).toBe('SELECT pg_advisory_unlock(hashtextextended($1, 0))');
    expect(released).toEqual([undefined]);
    expect(listeners.size).toBe(0);
    expect(existsSync(liveAppLockDir(url))).toBe(false);
  });

  it('gives null, and lets the directory go, while another daemon holds the app', async () => {
    const url = appUrl();
    const { logger } = capture();
    const { pool, released } = fakePool({ locked: false });
    expect(await liveAppLock(pool, url, logger).tryAcquire()).toBeNull();
    expect(released).toEqual([undefined]);
    expect(existsSync(liveAppLockDir(url))).toBe(false);
  });

  it('drops the connection when the unlock fails, which drops the lock', async () => {
    const url = appUrl();
    const { logger } = capture();
    const { pool, released } = fakePool({ unlockFails: true });
    const release = await liveAppLock(pool, url, logger).tryAcquire();
    await expect(release?.()).resolves.toBeUndefined();
    expect(released).toMatchObject([{ message: 'connection lost' }]);
    expect(existsSync(liveAppLockDir(url))).toBe(false);
  });

  it('rejects when Postgres is down, and lets the directory go', async () => {
    const url = appUrl();
    const { logger } = capture();
    const { pool } = fakePool({ connectFails: true });
    await expect(liveAppLock(pool, url, logger).tryAcquire()).rejects.toThrow('database is down');
    expect(existsSync(liveAppLockDir(url))).toBe(false);
  });
});

describe('liveAppLock keys', () => {
  it('claims one app however its URL is spelled', async () => {
    const host = `${randomUUID()}.example.com`;
    const { logger } = capture();
    const { pool } = fakePool();
    const release = await liveAppLock(pool, `https://${host}/`, logger).tryAcquire();
    expect(
      await liveAppLock(pool, `https://${host.toUpperCase()}:443`, logger).tryAcquire(),
    ).toBeNull();
    await release?.();
  });
});
