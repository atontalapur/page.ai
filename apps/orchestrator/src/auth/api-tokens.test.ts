import * as crypto from 'node:crypto';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiTokens,
  FAILED_TOKEN_WINDOW_MS,
  FAILED_TOKENS_PER_WINDOW,
  tokenWarnings,
} from './api-tokens.ts';
import { hashToken } from './dashboard-tokens.ts';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

afterEach(() => vi.clearAllMocks());

const logger = pino({ enabled: false });
const people = [
  { name: 'Arjun', sha256: hashToken('arjun-token') },
  { name: 'Daniyal', sha256: hashToken('daniyal-token') },
];

type TokenConfig = ConstructorParameters<typeof ApiTokens>[0];

function tokens(
  now = () => 0,
  config: TokenConfig = { apiToken: 'shared-token', dashboardTokens: people },
) {
  return new ApiTokens(config, logger, now);
}

describe('ApiTokens.identify', () => {
  it('names the person a personal token belongs to, and the shared token as shared', () => {
    const t = tokens();
    expect(t.identify('arjun-token')).toEqual({ kind: 'person', name: 'Arjun' });
    expect(t.identify('daniyal-token')).toEqual({ kind: 'person', name: 'Daniyal' });
    expect(t.identify('shared-token')).toEqual({ kind: 'shared' });
    expect(t.personal).toBe(true);
  });

  it.each([
    undefined,
    '',
    42,
    'wrong',
    hashToken('arjun-token'),
    'arjun-token ',
    'Bearer arjun-token',
  ])('knows no one for %j', (token) => {
    expect(tokens().identify(token)).toBeUndefined();
  });

  it('compares a token with every digest in constant time, even once one has matched', () => {
    tokens().identify('arjun-token');
    const equal = vi.mocked(crypto.timingSafeEqual);
    // Two people and the shared token, each compared as 32-byte digests.
    expect(equal).toHaveBeenCalledTimes(3);
    for (const [a, b] of equal.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });

  it('opens nothing when no token is configured', () => {
    const none = tokens(() => 0, { apiToken: undefined, dashboardTokens: [] });
    expect(none.identify('anything')).toBeUndefined();
    expect(none.personal).toBe(false);
  });

  it('takes the shared token alone when no personal token is configured', () => {
    const shared = tokens(() => 0, { apiToken: 'shared-token', dashboardTokens: [] });
    expect(shared.identify('shared-token')).toEqual({ kind: 'shared' });
    expect(shared.personal).toBe(false);
  });
});

describe('ApiTokens.check', () => {
  it(`refuses an address after ${FAILED_TOKENS_PER_WINDOW} wrong tokens until its window ends`, () => {
    let now = 0;
    const warn = vi.spyOn(logger, 'warn');
    const t = tokens(() => now);
    for (let i = 0; i < FAILED_TOKENS_PER_WINDOW; i++) {
      expect(t.check('guess', '198.51.100.1')).toEqual({
        ok: false,
        refusal: 'unauthorized',
        retryAfterMs: 0,
      });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    now = 60_000;
    // The right token too, so a guesser learns nothing more.
    expect(t.check('arjun-token', '198.51.100.1')).toEqual({
      ok: false,
      refusal: 'rate_limited',
      retryAfterMs: FAILED_TOKEN_WINDOW_MS - 60_000,
    });
    expect(t.check('arjun-token', '198.51.100.2')).toMatchObject({ ok: true });
    now = FAILED_TOKEN_WINDOW_MS;
    expect(t.check('arjun-token', '198.51.100.1')).toEqual({
      ok: true,
      caller: { kind: 'person', name: 'Arjun' },
    });
  });

  it('does not count a request that sent no token', () => {
    const t = tokens();
    for (let i = 0; i < FAILED_TOKENS_PER_WINDOW * 2; i++) {
      expect(t.check(undefined, '198.51.100.3')).toMatchObject({ refusal: 'unauthorized' });
      expect(t.check('', '198.51.100.3')).toMatchObject({ refusal: 'unauthorized' });
    }
    expect(t.check('shared-token', '198.51.100.3')).toEqual({
      ok: true,
      caller: { kind: 'shared' },
    });
  });
});

describe('tokenWarnings', () => {
  it('warns while decisions use name labels, and when the API is closed', () => {
    expect(tokenWarnings({ apiToken: 'x', dashboardTokens: people })).toEqual([]);
    expect(tokenWarnings({ apiToken: 'x', dashboardTokens: [] })).toEqual([
      expect.stringContaining('DASHBOARD_TOKENS is unset'),
    ]);
    expect(tokenWarnings({ apiToken: undefined, dashboardTokens: [] })).toEqual([
      expect.stringContaining('every route but /health and /ingest returns 401'),
      expect.stringContaining('DASHBOARD_TOKENS is unset'),
    ]);
    expect(tokenWarnings({ apiToken: undefined, dashboardTokens: people })).toEqual([
      expect.stringContaining('only personal dashboard tokens open the API'),
    ]);
  });
});
