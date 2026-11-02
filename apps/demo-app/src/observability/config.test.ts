import { describe, expect, it, vi } from 'vitest';
import { loadReportingConfig, safeReportingConfig } from './config.ts';

describe('loadReportingConfig', () => {
  it('defaults to no key, the US cloud host and a dev release', () => {
    expect(loadReportingConfig({})).toEqual({
      key: undefined,
      host: 'https://us.i.posthog.com',
      release: 'dev',
    });
  });

  it('treats a blank key as unset', () => {
    expect(loadReportingConfig({ POSTHOG_KEY: '  ' }).key).toBeUndefined();
  });

  it('reads the key, host and Railway commit', () => {
    expect(
      loadReportingConfig({
        POSTHOG_KEY: 'phc_test',
        POSTHOG_HOST: 'https://eu.i.posthog.com',
        RAILWAY_GIT_COMMIT_SHA: 'abc123',
      }),
    ).toEqual({ key: 'phc_test', host: 'https://eu.i.posthog.com', release: 'abc123' });
  });

  it('rejects a host that is not a URL', () => {
    expect(() => loadReportingConfig({ POSTHOG_HOST: 'posthog' })).toThrow();
  });
});

describe('safeReportingConfig', () => {
  it('turns reporting off instead of throwing on a bad value', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      safeReportingConfig({ POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'nope' }).key,
    ).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('passes a good config through', () => {
    expect(safeReportingConfig({ POSTHOG_KEY: 'phc_test' }).key).toBe('phc_test');
  });
});
