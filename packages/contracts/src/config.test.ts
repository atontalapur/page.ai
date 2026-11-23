import { describe, expect, it } from 'vitest';
import { nodeEnvFixture, orchestratorEnvFixture } from './__fixtures__/index.ts';
import { demoAppConfigSchema, nodeConfigSchema, orchestratorConfigSchema } from './config.ts';

// Config is parsed from string env vars into typed values, so these tests check the
// parsed output instead of a JSON round-trip.
describe('orchestratorConfigSchema', () => {
  it('parses a full env into typed values', () => {
    expect(orchestratorConfigSchema.parse(orchestratorEnvFixture)).toMatchObject({
      PORT: 8080,
      USE_FAKE_ADAPTERS: false,
      NOTIFY_TO_NUMBERS: ['+15550000001', '+15550000002'],
    });
  });

  it('applies defaults and needs no third-party secrets with fake adapters', () => {
    const config = orchestratorConfigSchema.parse({
      USE_FAKE_ADAPTERS: 'true',
      DATABASE_URL: orchestratorEnvFixture.DATABASE_URL,
      NODE_SHARED_SECRET: 'node-secret',
      POSTHOG_WEBHOOK_SECRET: 'webhook-secret',
    });
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 4000,
      USE_FAKE_ADAPTERS: true,
    });
  });

  it('rejects a missing DATABASE_URL', () => {
    const env = { ...orchestratorEnvFixture, DATABASE_URL: undefined };
    expect(() => orchestratorConfigSchema.parse(env)).toThrow(/DATABASE_URL/);
  });

  it('requires third-party secrets when real adapters are on', () => {
    const env = { ...orchestratorEnvFixture, TWILIO_AUTH_TOKEN: undefined };
    expect(() => orchestratorConfigSchema.parse(env)).toThrow(/TWILIO_AUTH_TOKEN/);
  });

  it('reports a missing secret alongside other invalid vars', () => {
    const env = {
      ...orchestratorEnvFixture,
      DATABASE_URL: undefined,
      TWILIO_AUTH_TOKEN: undefined,
    };
    const result = orchestratorConfigSchema.safeParse(env);
    expect(result.error?.issues.map((issue) => issue.path[0])).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'TWILIO_AUTH_TOKEN']),
    );
  });

  it('treats blank vars from a copied .env.example as unset', () => {
    const config = orchestratorConfigSchema.parse({
      ...orchestratorEnvFixture,
      USE_FAKE_ADAPTERS: '',
      PORT: '',
      LOG_LEVEL: ' ',
    });
    expect(config).toMatchObject({ USE_FAKE_ADAPTERS: false, PORT: 4000, LOG_LEVEL: 'info' });
  });

  it('needs no blank third-party secrets with fake adapters', () => {
    const env = {
      USE_FAKE_ADAPTERS: 'true',
      DATABASE_URL: orchestratorEnvFixture.DATABASE_URL,
      NODE_SHARED_SECRET: 'node-secret',
      POSTHOG_WEBHOOK_SECRET: 'webhook-secret',
      OPENROUTER_API_KEY: '',
      TWILIO_AUTH_TOKEN: '',
      NOTIFY_TO_NUMBERS: '',
    };
    expect(orchestratorConfigSchema.parse(env).OPENROUTER_API_KEY).toBeUndefined();
  });

  it('rejects an env that is not an object', () => {
    expect(orchestratorConfigSchema.safeParse(undefined).success).toBe(false);
  });

  it('rejects a NOTIFY_TO_NUMBERS list with no numbers in it', () => {
    const env = { ...orchestratorEnvFixture, NOTIFY_TO_NUMBERS: ' , ' };
    expect(() => orchestratorConfigSchema.parse(env)).toThrow(/NOTIFY_TO_NUMBERS/);
  });
});

describe('nodeConfigSchema', () => {
  it('parses a full env', () => {
    expect(nodeConfigSchema.parse(nodeEnvFixture)).toMatchObject({
      ORCHESTRATOR_URL: nodeEnvFixture.ORCHESTRATOR_URL,
      GITHUB_REPO: 'atontalapur/page-demo',
    });
  });

  it('requires GitHub credentials when real adapters are on', () => {
    const env = { ...nodeEnvFixture, GITHUB_TOKEN: undefined };
    expect(() => nodeConfigSchema.parse(env)).toThrow(/GITHUB_TOKEN/);
  });

  it('defaults the pg-boss schema, sandbox image and sandbox runtime', () => {
    expect(nodeConfigSchema.parse(nodeEnvFixture)).toMatchObject({
      PGBOSS_SCHEMA: 'pgboss',
      SANDBOX_IMAGE: 'page-sandbox',
      SANDBOX_RUNTIME: 'docker',
    });
  });

  it('takes the local sandbox runtime and refuses an unknown one', () => {
    const local = nodeConfigSchema.parse({ ...nodeEnvFixture, SANDBOX_RUNTIME: 'local' });
    expect(local.SANDBOX_RUNTIME).toBe('local');
    expect(() => nodeConfigSchema.parse({ ...nodeEnvFixture, SANDBOX_RUNTIME: 'vm' })).toThrow(
      /SANDBOX_RUNTIME/,
    );
  });

  it('requires a model when real adapters are on, but not with fakes', () => {
    const env = { ...nodeEnvFixture, OPENROUTER_MODEL: '' };
    expect(() => nodeConfigSchema.parse(env)).toThrow(/OPENROUTER_MODEL/);
    expect(nodeConfigSchema.parse({ ...env, USE_FAKE_ADAPTERS: 'true' })).not.toHaveProperty(
      'OPENROUTER_MODEL',
    );
  });

  it('rejects a GITHUB_REPO that is not owner/name', () => {
    expect(() => nodeConfigSchema.parse({ ...nodeEnvFixture, GITHUB_REPO: 'page-demo' })).toThrow();
  });

  describe('the ops app', () => {
    const secret = 'a'.repeat(32);
    const parse = (env: Record<string, string | undefined>) =>
      nodeConfigSchema.safeParse({ ...nodeEnvFixture, ...env });
    const issues = (env: Record<string, string | undefined>) => {
      const result = parse(env);
      return result.success ? [] : result.error.issues.map((i) => i.message);
    };

    it('takes https anywhere and http on this machine only', () => {
      expect(parse({ OPS_APP_URL: 'https://demo.example.com', OPS_SECRET: secret }).success).toBe(
        true,
      );
      expect(parse({ OPS_APP_URL: 'http://[::1]:3000', OPS_SECRET: secret }).success).toBe(true);
      expect(issues({ OPS_APP_URL: 'http://demo.example.com', OPS_SECRET: secret })).toEqual([
        expect.stringContaining('so OPS_SECRET is not sent in the clear'),
      ]);
    });

    it.each([
      'https://u:p@demo.example.com',
      'https://u@demo.example.com',
      'https://d.example.com?a',
      'https://d.example.com#a',
    ])('refuses %s', (url) => {
      expect(issues({ OPS_APP_URL: url, OPS_SECRET: secret })).toEqual([
        'takes no user, password, query or fragment',
      ]);
    });

    it.each(['not a url', 'localhost:3000', 'ftp://demo.example.com'])(
      'reports %s as one URL error rather than throwing',
      (url) => {
        expect(issues({ OPS_APP_URL: url, OPS_SECRET: secret })).toEqual([
          expect.stringMatching(/invalid url/i),
        ]);
      },
    );

    it('trims the secret, and checks it only with the URL and real adapters', () => {
      const ok = parse({ OPS_APP_URL: 'https://d.example.com', OPS_SECRET: `  ${secret} ` });
      expect(ok.success && ok.data.OPS_SECRET).toBe(secret);
      expect(issues({ OPS_APP_URL: 'https://d.example.com', OPS_SECRET: ' short ' })).toEqual([
        expect.stringContaining('OPS_SECRET is under 32 characters'),
      ]);
      expect(issues({ OPS_APP_URL: 'https://d.example.com' })).toEqual([
        'OPS_SECRET is required with OPS_APP_URL',
      ]);
      expect(parse({ OPS_SECRET: 'short' }).success).toBe(true);
      expect(
        parse({ OPS_APP_URL: 'http://localhost:3000', USE_FAKE_ADAPTERS: 'true' }).success,
      ).toBe(true);
    });
  });

  describe("the ops app's Railway service", () => {
    const app = { OPS_APP_URL: 'https://demo.example.com', OPS_SECRET: 'a'.repeat(32) };
    const railway = {
      OPS_RAILWAY_TOKEN: 'project-token',
      OPS_RAILWAY_PROJECT_ID: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
      OPS_RAILWAY_ENVIRONMENT_ID: '0b4a3a5e-9a3c-4c8e-8f0e-1f2d3c4b5a69',
      OPS_RAILWAY_SERVICE_ID: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
    };
    const parse = (env: Record<string, string | undefined>) =>
      nodeConfigSchema.safeParse({ ...nodeEnvFixture, ...env });
    const issues = (env: Record<string, string | undefined>) => {
      const result = parse(env);
      return result.success ? [] : result.error.issues.map((i) => i.message);
    };

    it('is optional, and takes all four with the ops app', () => {
      const alone = parse(app);
      expect(alone.success && alone.data.OPS_RAILWAY_TOKEN).toBeUndefined();
      expect(parse({ ...app, ...railway, OPS_RAILWAY_TOKEN: ' project-token\n' })).toMatchObject({
        success: true,
        data: { ...railway },
      });
    });

    it('names every var a partial set is missing', () => {
      expect(issues({ ...app, OPS_RAILWAY_TOKEN: 'project-token' })).toEqual([
        'OPS_RAILWAY_PROJECT_ID is required with OPS_RAILWAY_TOKEN',
        'OPS_RAILWAY_ENVIRONMENT_ID is required with OPS_RAILWAY_TOKEN',
        'OPS_RAILWAY_SERVICE_ID is required with OPS_RAILWAY_TOKEN',
      ]);
    });

    it('needs the ops app, the one a rollback changes', () => {
      expect(issues(railway)).toEqual([
        'OPS_APP_URL is required with OPS_RAILWAY_*: a rollback changes that app',
      ]);
    });

    it('refuses an id that is not a UUID', () => {
      expect(issues({ ...app, ...railway, OPS_RAILWAY_SERVICE_ID: 'demo-app' })).toEqual([
        'must be a Railway id, which is a UUID',
      ]);
    });

    // Railway sets these on every service it runs, the daemon's own included.
    it("ignores Railway's own vars, so the daemon never rolls back its own service", () => {
      const own = {
        RAILWAY_TOKEN: 'cli-token',
        RAILWAY_PROJECT_ID: railway.OPS_RAILWAY_PROJECT_ID,
        RAILWAY_ENVIRONMENT_ID: railway.OPS_RAILWAY_ENVIRONMENT_ID,
        RAILWAY_SERVICE_ID: railway.OPS_RAILWAY_SERVICE_ID,
      };
      const result = parse({ ...app, ...own });
      expect(result.success && result.data.OPS_RAILWAY_SERVICE_ID).toBeUndefined();
      expect(result.success && 'RAILWAY_SERVICE_ID' in result.data).toBe(false);
    });

    it('is not checked with fakes on, which deploy nothing', () => {
      const result = parse({ USE_FAKE_ADAPTERS: 'true', OPS_RAILWAY_TOKEN: 'project-token' });
      expect(result.success).toBe(true);
    });
  });
});

describe('demoAppConfigSchema', () => {
  it('runs with no PostHog key, so the fake reporter is used', () => {
    expect(demoAppConfigSchema.parse({})).toEqual({ POSTHOG_HOST: 'https://us.i.posthog.com' });
  });

  it('rejects a POSTHOG_HOST that is not a URL', () => {
    expect(() => demoAppConfigSchema.parse({ POSTHOG_HOST: 'posthog' })).toThrow();
  });
});
