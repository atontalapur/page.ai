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
      posthogWebhookSecret: undefined,
      openRouterApiKey: undefined,
      triageModel: 'openai/gpt-4o-mini',
      triageTimeoutMs: 8000,
      twilio: undefined,
      notifyTo: [],
      dashboardUrl: 'http://localhost:3000',
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

  it('treats blank vars as unset, like the node daemon', () => {
    const blank = { PORT: '', HOST: ' ', PGBOSS_SCHEMA: '', LOG_LEVEL: '' };
    expect(loadConfig({ DATABASE_URL, ...blank })).toMatchObject({
      port: 4000,
      host: '0.0.0.0',
      pgbossSchema: 'pgboss',
      logLevel: 'info',
    });
    expect(() => loadConfig({ DATABASE_URL: ' ', ...blank })).toThrow(
      'invalid config: DATABASE_URL is required',
    );
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

  it('treats blank secrets as unset and keeps a partial Twilio config from booting', () => {
    expect(
      loadConfig({
        DATABASE_URL,
        POSTHOG_WEBHOOK_SECRET: ' ',
        OPENROUTER_API_KEY: '',
        NOTIFY_TO_NUMBERS: ' +15550000001, +15550000002 ',
      }),
    ).toMatchObject({
      posthogWebhookSecret: undefined,
      openRouterApiKey: undefined,
      notifyTo: ['+15550000001', '+15550000002'],
    });
    expect(() => loadConfig({ DATABASE_URL, TWILIO_ACCOUNT_SID: 'AC123' })).toThrow(
      'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are set together',
    );
    expect(
      loadConfig({
        DATABASE_URL,
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_FROM_NUMBER: '+15550000000',
      }).twilio,
    ).toEqual({ accountSid: 'AC123', authToken: 'token', from: '+15550000000' });
  });

  it('rejects an unknown USE_FAKE_ADAPTERS value', () => {
    expect(() => loadConfig({ DATABASE_URL, USE_FAKE_ADAPTERS: 'maybe' })).toThrow(
      /^invalid config: USE_FAKE_ADAPTERS: Invalid option/,
    );
  });
});
