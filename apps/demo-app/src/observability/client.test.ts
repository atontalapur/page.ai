import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientReporter,
  initClientReporting,
  reportBoundaryError,
  resetClientReporting,
  type PostHogBrowserClient,
} from './client.ts';
import { FakeErrorReporter } from './reporter.ts';

const config = { key: 'phc_test', host: 'https://us.i.posthog.com', release: 'sha' };

function fakeClient() {
  const init = vi.fn<PostHogBrowserClient['init']>();
  const register = vi.fn<PostHogBrowserClient['register']>();
  const captureException = vi.fn<PostHogBrowserClient['captureException']>();
  return { client: { init, register, captureException }, init, register, captureException };
}

afterEach(() => {
  resetClientReporting();
  vi.restoreAllMocks();
});

describe('initClientReporting', () => {
  it('does nothing without a key', () => {
    const { client, init } = fakeClient();
    initClientReporting({ ...config, key: undefined }, client);
    expect(init).not.toHaveBeenCalled();
    expect(clientReporter()).toBeInstanceOf(FakeErrorReporter);
  });

  it('starts posthog-js with exception autocapture and tags the release', async () => {
    const { client, init, register, captureException } = fakeClient();
    initClientReporting(config, client);
    expect(init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({ api_host: config.host, capture_exceptions: true }),
    );
    expect(register).toHaveBeenCalledWith({ release: 'sha' });

    const error = new TypeError('boom');
    await clientReporter().captureException(error, { source: 'client' });
    expect(captureException).toHaveBeenCalledWith(error, {
      error_name: 'TypeError',
      release: 'sha',
      source: 'client',
    });
  });

  it('swallows a failing capture', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, captureException } = fakeClient();
    captureException.mockImplementation(() => {
      throw new Error('blocked');
    });
    initClientReporting(config, client);
    await expect(clientReporter().captureException(new Error('x'), {})).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('reportBoundaryError', () => {
  it('reports a browser error', () => {
    const error = new Error('render');
    expect(reportBoundaryError(error)).toBe(true);
    expect((clientReporter() as FakeErrorReporter).captured).toMatchObject([
      { error, properties: { source: 'client' } },
    ]);
  });

  it('skips a server error, which onRequestError already reported', () => {
    expect(reportBoundaryError(Object.assign(new Error('x'), { digest: '123' }))).toBe(false);
    expect((clientReporter() as FakeErrorReporter).captured).toEqual([]);
  });
});
