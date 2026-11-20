import { nodeEnvFixture } from '@page/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('parses a full env', () => {
    expect(loadConfig(nodeEnvFixture)).toMatchObject({
      ok: true,
      value: { SANDBOX_IMAGE: 'page-sandbox', USE_FAKE_ADAPTERS: false },
    });
  });

  it('needs no third-party secrets with fakes on', () => {
    const { DATABASE_URL, ORCHESTRATOR_URL, NODE_SHARED_SECRET } = nodeEnvFixture;
    const env = { DATABASE_URL, ORCHESTRATOR_URL, NODE_SHARED_SECRET, USE_FAKE_ADAPTERS: 'true' };
    expect(loadConfig(env).ok).toBe(true);
  });

  describe('the live demo app for Tier 3 ops tools', () => {
    const secret = 'a'.repeat(32);
    const url = 'https://demo.example.com';

    it('is optional', () => {
      const result = loadConfig(nodeEnvFixture);
      expect(result.ok && result.value.OPS_APP_URL).toBeUndefined();
    });

    it('takes the app URL with its ops secret', () => {
      expect(loadConfig({ ...nodeEnvFixture, OPS_APP_URL: url, OPS_SECRET: secret })).toMatchObject(
        {
          ok: true,
          value: { OPS_APP_URL: url, OPS_SECRET: secret },
        },
      );
    });

    // .env keeps staging's app in DEMO_APP_URL and the compose app's secret in OPS_SECRET,
    // for the e2e test and docker compose. Neither may point the daemon at an app.
    it('ignores DEMO_APP_URL, and boots with an OPS_SECRET it does not use', () => {
      const env = { ...nodeEnvFixture, DEMO_APP_URL: url, OPS_SECRET: 'short' };
      const result = loadConfig(env);
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.value.OPS_APP_URL).toBeUndefined();
    });

    it('refuses the app URL without its ops secret', () => {
      const result = loadConfig({ ...nodeEnvFixture, OPS_APP_URL: url });
      expect(result.ok ? '' : result.error).toContain('OPS_SECRET is required with OPS_APP_URL');
    });

    it('refuses an ops secret the demo app would reject', () => {
      const result = loadConfig({ ...nodeEnvFixture, OPS_APP_URL: url, OPS_SECRET: 'short' });
      expect(result.ok ? '' : result.error).toContain(
        'OPS_SECRET is under 32 characters, which the demo app refuses',
      );
    });

    it.each(['localhost:3000', 'ftp://demo.example.com', 'javascript:alert(1)'])(
      'refuses %s as the app URL',
      (bad) => {
        const result = loadConfig({ ...nodeEnvFixture, OPS_APP_URL: bad, OPS_SECRET: secret });
        expect(result.ok ? '' : result.error).toContain('OPS_APP_URL');
      },
    );
  });

  it('reports every missing var at once', () => {
    const result = loadConfig({});
    expect(result.ok).toBe(false);
    const message = result.ok ? '' : result.error;
    for (const key of [
      'DATABASE_URL',
      'ORCHESTRATOR_URL',
      'NODE_SHARED_SECRET',
      'OPENROUTER_MODEL',
    ]) {
      expect(message).toContain(key);
    }
  });
});
