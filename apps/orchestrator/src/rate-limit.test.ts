import { describe, expect, it } from 'vitest';
import { clientAddress, RateLimiter } from './rate-limit.ts';

describe('RateLimiter', () => {
  it('allows `limit` hits per window and key, then refuses until the window resets', () => {
    let now = 1_000;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.hit('a')).toEqual({ allowed: true, retryAfterMs: 60_000 });
    expect(limiter.hit('a').allowed).toBe(true);
    now += 15_000;
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterMs: 45_000 });
    // Another key has its own count.
    expect(limiter.hit('b').allowed).toBe(true);
    now += 45_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('forgets keys whose window has passed', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    limiter.hit('old');
    now = 5_000;
    limiter.hit('new');
    const windows = (limiter as unknown as { windows: Map<string, unknown> }).windows;
    expect([...windows.keys()]).toEqual(['new']);
  });
});

describe('clientAddress', () => {
  it('takes the last X-Forwarded-For entry, which the proxy added', () => {
    expect(clientAddress('10.0.0.1', '1.1.1.1, 2.2.2.2')).toBe('2.2.2.2');
    expect(clientAddress('10.0.0.1', ['1.1.1.1', '3.3.3.3'])).toBe('3.3.3.3');
  });

  it('falls back to the socket address', () => {
    expect(clientAddress('10.0.0.1', undefined)).toBe('10.0.0.1');
    expect(clientAddress('10.0.0.1', ' ')).toBe('10.0.0.1');
    expect(clientAddress(undefined, undefined)).toBe('unknown');
  });
});
