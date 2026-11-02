import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const DATABASE_URL = 'postgres://page:page@localhost:5432/page';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      port: 4000,
      host: '0.0.0.0',
      pgbossSchema: 'pgboss',
    });
  });

  it('reads overrides', () => {
    expect(
      loadConfig({ DATABASE_URL, PORT: '8080', HOST: '127.0.0.1', PGBOSS_SCHEMA: 'jobs' }),
    ).toMatchObject({ port: 8080, host: '127.0.0.1', pgbossSchema: 'jobs' });
  });

  it('rejects bad settings', () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x/y' })).toThrow();
    expect(() => loadConfig({ DATABASE_URL, PORT: '0' })).toThrow();
    expect(() => loadConfig({ DATABASE_URL, PGBOSS_SCHEMA: 'drop table;' })).toThrow();
  });
});
