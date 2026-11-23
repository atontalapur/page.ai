import { nodeEnvFixture } from '@page/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { loadConfig, nodeName } from './config.ts';

describe('nodeName', () => {
  it('is NODE_NAME when set', () => {
    expect(nodeName({ NODE_NAME: 'railway-node' }, 'a1b2c3d4e5f6')).toBe('railway-node');
  });

  it('falls back on the hostname, made into a valid name', () => {
    expect(nodeName({}, 'Advaiths-MacBook-Pro.local')).toBe('Advaiths-MacBook-Pro.local');
    expect(nodeName({}, 'my laptop')).toBe('my-laptop');
  });

  it("reads this machine's hostname by default", () => {
    expect(nodeName({})).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});

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

  describe("the ops app's Railway service for the rollback tool", () => {
    const app = { OPS_APP_URL: 'https://demo.example.com', OPS_SECRET: 'a'.repeat(32) };
    const railway = {
      OPS_RAILWAY_TOKEN: 'project-token',
      OPS_RAILWAY_PROJECT_ID: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
      OPS_RAILWAY_ENVIRONMENT_ID: '0b4a3a5e-9a3c-4c8e-8f0e-1f2d3c4b5a69',
      OPS_RAILWAY_SERVICE_ID: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
    };

    it('is optional, and taken whole with the ops app', () => {
      expect(loadConfig({ ...nodeEnvFixture, ...app })).toMatchObject({ ok: true });
      expect(loadConfig({ ...nodeEnvFixture, ...app, ...railway })).toMatchObject({
        ok: true,
        value: railway,
      });
    });

    it('refuses part of it, or all of it without the ops app, at boot', () => {
      const partial = { ...railway, OPS_RAILWAY_SERVICE_ID: undefined };
      const missing = loadConfig({ ...nodeEnvFixture, ...app, ...partial });
      expect(missing.ok ? '' : missing.error).toContain('OPS_RAILWAY_SERVICE_ID is required');
      const alone = loadConfig({ ...nodeEnvFixture, ...railway });
      expect(alone.ok ? '' : alone.error).toContain('OPS_APP_URL is required with OPS_RAILWAY_*');
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
