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
      PORT: 3000,
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
