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

    it.each([
      'localhost:3000',
      'ftp://demo.example.com',
      'javascript:alert(1)',
      // The bearer secret would go out in the clear.
      'http://page-demo.up.railway.app',
      // The ops client can't send credentials in a URL, or join paths onto a query.
      'https://user:pass@demo.example.com',
      'https://demo.example.com/?x=1',
      'https://demo.example.com/#top',
    ])('refuses %s as the app URL', (bad) => {
      const result = loadConfig({ ...nodeEnvFixture, OPS_APP_URL: bad, OPS_SECRET: secret });
      expect(result.ok ? '' : result.error).toContain('OPS_APP_URL');
    });

    it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
      'takes plain http for %s',
      (local) => {
        const result = loadConfig({ ...nodeEnvFixture, OPS_APP_URL: local, OPS_SECRET: secret });
        expect(result).toMatchObject({ ok: true, value: { OPS_APP_URL: local } });
      },
    );

    it('trims the ops secret before checking its length, as the eval does', () => {
      const padded = loadConfig({
        ...nodeEnvFixture,
        OPS_APP_URL: url,
        OPS_SECRET: ` ${secret}\n`,
      });
      expect(padded).toMatchObject({ ok: true, value: { OPS_SECRET: secret } });

      const short = ` ${'a'.repeat(30)} `;
      const result = loadConfig({ ...nodeEnvFixture, OPS_APP_URL: url, OPS_SECRET: short });
      expect(result.ok ? '' : result.error).toContain('OPS_SECRET is under 32 characters');
    });

    it('needs no ops secret with fakes on, which ignore the app URL', () => {
      const env = {
        ...nodeEnvFixture,
        USE_FAKE_ADAPTERS: 'true',
        OPS_APP_URL: 'http://localhost:3000',
      };
      expect(loadConfig(env)).toMatchObject({ ok: true });
    });
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
