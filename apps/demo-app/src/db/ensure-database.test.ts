import { beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => {
  const state = {
    connectError: undefined as Error | undefined,
    queries: [] as string[],
    urls: [] as string[],
  };
  class Client {
    readonly url: string;
    constructor({ connectionString }: { connectionString: string }) {
      this.url = connectionString;
      state.urls.push(connectionString);
    }
    connect() {
      // Only the first client (the probe against the target database) can fail.
      if (state.urls.length === 1 && state.connectError) return Promise.reject(state.connectError);
      return Promise.resolve();
    }
    query(sql: string) {
      state.queries.push(sql);
      return Promise.resolve({ rows: [] });
    }
    end() {
      return Promise.resolve();
    }
    escapeIdentifier(name: string) {
      return `"${name}"`;
    }
  }
  return { state, Client };
});
vi.mock('pg', () => ({ default: { Client: pg.Client } }));

const { ensureDatabase } = await import('./ensure-database.ts');
const url = 'postgres://page:page@localhost:5432/demo';

describe('ensureDatabase', () => {
  beforeEach(() => {
    pg.state.connectError = undefined;
    pg.state.queries = [];
    pg.state.urls = [];
  });

  it('does nothing when the database exists', async () => {
    expect(await ensureDatabase(url)).toBe(false);
    expect(pg.state.queries).toEqual([]);
  });

  it('creates the database through the postgres maintenance db', async () => {
    pg.state.connectError = Object.assign(new Error('missing'), { code: '3D000' });

    expect(await ensureDatabase(url)).toBe(true);
    expect(pg.state.urls[1]).toBe('postgres://page:page@localhost:5432/postgres');
    expect(pg.state.queries).toEqual(['create database "demo"']);
  });

  it('rethrows any other connection error', async () => {
    const refused = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    pg.state.connectError = refused;

    await expect(ensureDatabase(url)).rejects.toBe(refused);
  });
});
