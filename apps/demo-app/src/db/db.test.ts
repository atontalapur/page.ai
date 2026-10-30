import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { fromPool } from './db.ts';

function fakePool() {
  const clientQuery = vi
    .fn<(sql: string) => Promise<{ rows: [] }>>()
    .mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const poolQuery = vi.fn<(sql: string) => Promise<{ rows: object[] }>>();
  poolQuery.mockResolvedValue({ rows: [{ one: 1 }] });
  const pool = {
    query: poolQuery,
    connect: () => Promise.resolve({ query: clientQuery, release }),
  } as unknown as Pool;
  const clientSql = () => clientQuery.mock.calls.map(([sql]) => sql);
  return { pool, poolQuery, clientSql, release };
}

describe('fromPool', () => {
  it('passes queries and exec through to the pool', async () => {
    const { pool, poolQuery } = fakePool();
    const db = fromPool(pool);
    expect(await db.query('select 1 as one')).toEqual({ rows: [{ one: 1 }] });
    await db.exec('select 1; select 2');
    expect(poolQuery).toHaveBeenLastCalledWith('select 1; select 2');
  });

  it('commits a transaction that resolves', async () => {
    const { pool, clientSql, release } = fakePool();
    const result = await fromPool(pool).transaction(async (tx) => {
      await tx.query('insert 1');
      await tx.exec('insert 2');
      return 'done';
    });

    expect(result).toBe('done');
    expect(clientSql()).toEqual(['begin', 'insert 1', 'insert 2', 'commit']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and rethrows when the callback throws', async () => {
    const { pool, clientSql, release } = fakePool();
    const boom = new Error('boom');

    await expect(fromPool(pool).transaction(() => Promise.reject(boom))).rejects.toBe(boom);
    expect(clientSql()).toEqual(['begin', 'rollback']);
    expect(release).toHaveBeenCalledOnce();
  });
});
