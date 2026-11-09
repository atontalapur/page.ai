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

  it('defaults the pg-boss schema and sandbox image', () => {
    expect(nodeConfigSchema.parse(nodeEnvFixture)).toMatchObject({
      PGBOSS_SCHEMA: 'pgboss',
      SANDBOX_IMAGE: 'page-sandbox',
    });
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
});

describe('demoAppConfigSchema', () => {
  it('runs with no PostHog key, so the fake reporter is used', () => {
    expect(demoAppConfigSchema.parse({})).toEqual({ POSTHOG_HOST: 'https://us.i.posthog.com' });
  });

  it('rejects a POSTHOG_HOST that is not a URL', () => {
    expect(() => demoAppConfigSchema.parse({ POSTHOG_HOST: 'posthog' })).toThrow();
  });
});
