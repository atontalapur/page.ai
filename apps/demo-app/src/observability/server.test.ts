import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeErrorReporter } from './reporter.ts';
import {
  createServerReporter,
  PostHogErrorReporter,
  resetServerReporter,
  serverReporter,
} from './server.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetServerReporter();
});

describe('serverReporter', () => {
  it('uses the fake when POSTHOG_KEY is unset, and nothing hits the network', async () => {
    vi.stubEnv('POSTHOG_KEY', '');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const reporter = serverReporter();
    expect(reporter).toBeInstanceOf(FakeErrorReporter);
    const error = new TypeError('boom');
    await reporter.captureException(error, { route: '/api/orders' });
    expect((reporter as FakeErrorReporter).captured).toMatchObject([
      { error, properties: { error_name: 'TypeError', route: '/api/orders' } },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(serverReporter()).toBe(reporter);
  });

  it('uses PostHog when a key is set', () => {
    const reporter = createServerReporter({
      key: 'phc_test',
      host: 'https://us.i.posthog.com',
      release: 'sha',
    });
    expect(reporter).toBeInstanceOf(PostHogErrorReporter);
  });
});

describe('PostHogErrorReporter', () => {
  it('sends a person-less exception immediately with route, release and error name', async () => {
    const client = { captureExceptionImmediate: vi.fn(() => Promise.resolve()) };
    const error = new RangeError('bad');
    await new PostHogErrorReporter(client, 'sha').captureException(error, {
      route: '/orders/[id]',
      source: 'render',
    });
    expect(client.captureExceptionImmediate).toHaveBeenCalledWith(error, undefined, {
      error_name: 'RangeError',
      release: 'sha',
      route: '/orders/[id]',
      source: 'render',
    });
  });

  it('logs and swallows a failed send', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = { captureExceptionImmediate: () => Promise.reject(new Error('offline')) };
    await expect(
      new PostHogErrorReporter(client, 'sha').captureException(new Error('x'), {}),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });
});
