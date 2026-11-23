/** What RateLimiter.hit decided. */
export interface RateDecision {
  allowed: boolean;
  /** How long until the key's window resets. Zero once it has. */
  retryAfterMs: number;
}

interface Window {
  resetAt: number;
  count: number;
}

/**
 * Counts hits per key in fixed windows. It lives in memory, so each orchestrator instance
 * counts its own clients, and a restart starts every count again. Expired windows are
 * dropped once per window, so the map holds only the keys seen in the last one.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private nextSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit for `key`, and refuses it once `key` is past the limit for its window. */
  hit(key: string): RateDecision {
    const now = this.now();
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { resetAt: now + this.windowMs, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return { allowed: window.count <= this.limit, retryAfterMs: window.resetAt - now };
  }

  /**
   * Whether one more hit for `key` would still be allowed, without counting one: false once
   * `key` has used every hit in its window.
   */
  peek(key: string): RateDecision {
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) return { allowed: true, retryAfterMs: 0 };
    return { allowed: window.count < this.limit, retryAfterMs: window.resetAt - now };
  }

  private sweep(now: number): void {
    if (now < this.nextSweep) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    this.nextSweep = now + this.windowMs;
  }
}

/**
 * The address to count a client's requests under. Railway's proxy puts the client's address
 * last in `X-Forwarded-For`, so that entry is the client. With no proxy in front, a client can
 * set the header itself and pick its own key; the API token, not this limit, keeps strangers
 * out.
 */
export function clientAddress(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor.at(-1) : forwardedFor;
  const last = header?.split(',').at(-1)?.trim();
  return last || remoteAddress || 'unknown';
}
