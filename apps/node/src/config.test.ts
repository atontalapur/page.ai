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
