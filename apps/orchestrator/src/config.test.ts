import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const DATABASE_URL = 'postgres://page:page@localhost:5432/page';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      databaseUrl: DATABASE_URL,
      port: 4000,
      host: '0.0.0.0',
      pgbossSchema: 'pgboss',
      useFakeAdapters: false,
      logLevel: 'info',
    });
  });

  it('reads overrides', () => {
    expect(
      loadConfig({ DATABASE_URL, PORT: '8080', HOST: '127.0.0.1', PGBOSS_SCHEMA: 'jobs' }),
    ).toMatchObject({ port: 8080, host: '127.0.0.1', pgbossSchema: 'jobs' });
  });

  it('rejects bad settings', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x/y' })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL, PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL, PGBOSS_SCHEMA: 'drop table;' })).toThrow(ConfigError);
  });

  it('names a missing var', () => {
    expect(() => loadConfig({})).toThrow('invalid config: DATABASE_URL is required');
  });

  it('lists every bad var in one error', () => {
    const env = { DATABASE_URL: 'mysql://x/y', PORT: '0', PGBOSS_SCHEMA: 'drop table;' };
    expect(() => loadConfig(env)).toThrow(
      'invalid config: DATABASE_URL: Invalid URL; PORT: Too small: expected number to be >=1; ' +
        'PGBOSS_SCHEMA: Invalid string: must match pattern /^[a-z_][a-z0-9_]*$/',
    );
  });

  it('reads USE_FAKE_ADAPTERS like the node daemon', () => {
    const fake = (value: string) => loadConfig({ DATABASE_URL, USE_FAKE_ADAPTERS: value });
    expect(fake('true').useFakeAdapters).toBe(true);
    expect(fake('1').useFakeAdapters).toBe(true);
    expect(fake('false').useFakeAdapters).toBe(false);
    expect(fake('0').useFakeAdapters).toBe(false);
    // A copied .env.example leaves it blank.
    expect(fake('').useFakeAdapters).toBe(false);
  });

  it('reads LOG_LEVEL, with blank meaning the default', () => {
    expect(loadConfig({ DATABASE_URL, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(loadConfig({ DATABASE_URL, LOG_LEVEL: '' }).logLevel).toBe('info');
    expect(() => loadConfig({ DATABASE_URL, LOG_LEVEL: 'loud' })).toThrow(
      /^invalid config: LOG_LEVEL: Invalid option/,
    );
  });

  it('rejects an unknown USE_FAKE_ADAPTERS value', () => {
    expect(() => loadConfig({ DATABASE_URL, USE_FAKE_ADAPTERS: 'maybe' })).toThrow(
      /^invalid config: USE_FAKE_ADAPTERS: Invalid option/,
    );
  });
});
