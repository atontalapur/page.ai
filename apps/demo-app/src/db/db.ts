import type { Pool, PoolClient, QueryResultRow } from 'pg';

export interface Queryable {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs one or more statements without parameters (simple query protocol). */
  exec(text: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Commits when `fn` resolves, rolls back when it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

function wrap(client: Pool | PoolClient): Queryable {
  return {
    query: (text, params) => client.query(text, params),
    exec: async (text) => {
      await client.query(text);
    },
  };
}

export function fromPool(pool: Pool): Db {
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      // Set when rollback fails: the connection is likely gone, so don't pool it again.
      let broken: Error | undefined;
      try {
        await client.query('begin');
        const result = await fn(wrap(client));
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback').catch((rollbackErr: Error) => {
          broken = rollbackErr;
        });
        throw err;
      } finally {
        client.release(broken);
      }
    },
  };
}
