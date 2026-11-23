import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashToken } from './auth/dashboard-tokens.ts';
import { ConfigError, loadConfig, loadPagerConfig } from './config.ts';

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
      apiToken: undefined,
      dashboardTokens: [],
      nodeSharedSecret: undefined,
      posthogWebhookSecret: undefined,
      openRouterApiKey: undefined,
      triageModel: 'openai/gpt-4o-mini',
      triageTimeoutMs: 8000,
      autoStartFix: false,
      autoStartFixMaxPerHour: 5,
      twilio: undefined,
      notifyTo: [],
      dashboardUrl: 'http://localhost:4000',
      uiDistDir: resolve('../ui/dist'),
      debug: undefined,
    });
  });

  it('resolves UI_DIST_DIR against the working directory', () => {
    expect(loadConfig({ DATABASE_URL, UI_DIST_DIR: '/srv/ui' }).uiDistDir).toBe('/srv/ui');
    expect(loadConfig({ DATABASE_URL, UI_DIST_DIR: 'build' }).uiDistDir).toBe(resolve('build'));
  });

  it('turns the debugging tools on only when asked, and only with the demo app and its secret', () => {
    expect(loadConfig({ DATABASE_URL }).debug).toBeUndefined();
    expect(() => loadConfig({ DATABASE_URL, DEBUG_TOOLS: 'true' })).toThrow(
      'DEBUG_TOOLS needs DEMO_APP_URL and OPS_SECRET',
    );
    expect(
      loadConfig({
        DATABASE_URL,
        DEBUG_TOOLS: 'true',
        DEMO_APP_URL: 'https://demo.example.com/',
        OPS_SECRET: 's'.repeat(32),
        POSTHOG_KEY: 'phc_test',
      }).debug,
    ).toEqual({
      demoAppUrl: 'https://demo.example.com',
      opsSecret: 's'.repeat(32),
      posthog: { key: 'phc_test', host: 'https://us.i.posthog.com' },
    });
  });

  it('reads overrides', () => {
    expect(
      loadConfig({ DATABASE_URL, PORT: '8080', HOST: '127.0.0.1', PGBOSS_SCHEMA: 'jobs' }),
    ).toMatchObject({ port: 8080, host: '127.0.0.1', pgbossSchema: 'jobs' });
    expect(loadConfig({ DATABASE_URL, NODE_SHARED_SECRET: 'node-secret' }).nodeSharedSecret).toBe(
      'node-secret',
    );
  });

  it('reads DASHBOARD_TOKENS as names and hashes', () => {
    const arjun = hashToken('arjun-token');
    const daniyal = hashToken('daniyal-token');
    const DASHBOARD_TOKENS = ` Arjun:${arjun.toUpperCase()}, ,Daniyal K:${daniyal},`;
    expect(loadConfig({ DATABASE_URL, DASHBOARD_TOKENS }).dashboardTokens).toEqual([
      { name: 'Arjun', sha256: arjun },
      { name: 'Daniyal K', sha256: daniyal },
    ]);
    expect(loadConfig({ DATABASE_URL, DASHBOARD_TOKENS: ' ' }).dashboardTokens).toEqual([]);
  });

  it('names what is wrong with a DASHBOARD_TOKENS entry, without the hash', () => {
    const hash = hashToken('t');
    const problem = (DASHBOARD_TOKENS: string) => {
      try {
        loadConfig({ DATABASE_URL, DASHBOARD_TOKENS });
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).not.toContain(hash);
        return (err as Error).message;
      }
      throw new Error('loaded');
    };
    expect(problem(`Arjun:${hash},Daniyal`)).toBe(
      'invalid config: DASHBOARD_TOKENS: entry 2 is not name:sha256',
    );
    expect(problem(`Arjun:${hash}:x`)).toContain('entry 1 is not name:sha256');
    expect(problem(`system:timed_out:${hash}`)).toContain('entry 1 is not name:sha256');
    expect(problem(`-arjun:${hash}`)).toContain('entry 1: the name must be');
    expect(problem('Arjun:abc123')).toContain('entry 1: the hash must be 64 hex characters');
    expect(problem(`Arjun:${hash},arjun:${hashToken('u')}`)).toContain(
      'entries 1 and 2 name one person',
    );
    expect(problem(`Arjun:${hash},Daniyal:${hash}`)).toContain('entries 1 and 2 hold one token');
  });

  it('refuses a shared API token that is also a personal one', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL,
        ORCHESTRATOR_API_TOKEN: 'shared',
        DASHBOARD_TOKENS: `Arjun:${hashToken('shared')}`,
      }),
    ).toThrow('ORCHESTRATOR_API_TOKEN is also in DASHBOARD_TOKENS');
  });

  it('reads AUTO_START_FIX', () => {
    expect(loadConfig({ DATABASE_URL, AUTO_START_FIX: 'true' }).autoStartFix).toBe(true);
    expect(loadConfig({ DATABASE_URL, AUTO_START_FIX: 'off' }).autoStartFix).toBe(false);
    expect(() => loadConfig({ DATABASE_URL, AUTO_START_FIX: 'maybe' })).toThrow(ConfigError);
  });

  it('reads AUTO_START_FIX_MAX_PER_HOUR, a positive whole number', () => {
    expect(loadConfig({ DATABASE_URL }).autoStartFixMaxPerHour).toBe(5);
    expect(
      loadConfig({ DATABASE_URL, AUTO_START_FIX_MAX_PER_HOUR: '20' }).autoStartFixMaxPerHour,
    ).toBe(20);
    for (const bad of ['0', '-1', '1.5', 'many']) {
      expect(() => loadConfig({ DATABASE_URL, AUTO_START_FIX_MAX_PER_HOUR: bad })).toThrow(
        ConfigError,
      );
    }
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
        ORCHESTRATOR_API_TOKEN: ' ',
        NODE_SHARED_SECRET: ' ',
        POSTHOG_WEBHOOK_SECRET: ' ',
        OPENROUTER_API_KEY: '',
        NOTIFY_TO_NUMBERS: ' +15550000001, +15550000002 ',
      }),
    ).toMatchObject({
      apiToken: undefined,
      nodeSharedSecret: undefined,
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
    ).toEqual({
      accountSid: 'AC123',
      authToken: 'token',
      from: '+15550000000',
      machineDetection: false,
      trial: false,
    });
    expect(
      loadConfig({
        DATABASE_URL,
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_FROM_NUMBER: '+15550000000',
        TWILIO_MACHINE_DETECTION: 'true',
        TWILIO_TRIAL: 'true',
      }).twilio,
    ).toMatchObject({ machineDetection: true, trial: true });
  });

  it('rejects an unknown USE_FAKE_ADAPTERS value', () => {
    expect(() => loadConfig({ DATABASE_URL, USE_FAKE_ADAPTERS: 'maybe' })).toThrow(
      /^invalid config: USE_FAKE_ADAPTERS: Invalid option/,
    );
  });
});

describe('loadPagerConfig', () => {
  it('reads the Twilio settings without the rest of the app', () => {
    expect(
      loadPagerConfig({
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_FROM_NUMBER: '+15550000000',
        NOTIFY_TO_NUMBERS: '+15550000001, +15550000002',
      }),
    ).toEqual({
      twilio: {
        accountSid: 'AC123',
        authToken: 'token',
        from: '+15550000000',
        machineDetection: false,
        trial: false,
      },
      notifyTo: ['+15550000001', '+15550000002'],
    });
    expect(() => loadPagerConfig({ TWILIO_ACCOUNT_SID: 'AC123' })).toThrow(ConfigError);
  });
});
