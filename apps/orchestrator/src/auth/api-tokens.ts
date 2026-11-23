import { timingSafeEqual } from 'node:crypto';
import type { SocketRefusal } from '@page/contracts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { RateLimiter } from '../rate-limit.ts';
import { tokenDigest } from './dashboard-tokens.ts';

/** Who sent a request or opened a socket, from the token it carried. */
export type Caller =
  /** A personal dashboard token: the person it names. */
  | { kind: 'person'; name: string }
  /** The shared ORCHESTRATOR_API_TOKEN, which names no one. */
  | { kind: 'shared' };

// Someone who mistypes or pastes an old token tries a few times. Ten wrong tokens from one
// address in ten minutes is a guesser, or a script stuck on a stale token.
export const FAILED_TOKENS_PER_WINDOW = 10;
export const FAILED_TOKEN_WINDOW_MS = 10 * 60_000;

/** What boot warns about the tokens, so an API that is closed or only labels names shows. */
export function tokenWarnings(config: Pick<Config, 'apiToken' | 'dashboardTokens'>): string[] {
  const people = config.dashboardTokens.length > 0;
  const warnings: string[] = [];
  if (!config.apiToken) {
    warnings.push(
      people
        ? 'ORCHESTRATOR_API_TOKEN is unset; only personal dashboard tokens open the API, so scripts get 401'
        : 'ORCHESTRATOR_API_TOKEN is unset; every route but /health and /ingest returns 401',
    );
  }
  if (!people) {
    warnings.push(
      'DASHBOARD_TOKENS is unset; Tier 3 decisions are recorded under the name each tab gives, ' +
        'which anyone with the API token can choose',
    );
  }
  return warnings;
}

/** What `check` decided: who the caller is, or why it is turned away. */
export type TokenCheck =
  { ok: true; caller: Caller } | { ok: false; refusal: SocketRefusal; retryAfterMs: number };

/**
 * The tokens that open the API and the UI socket: the shared ORCHESTRATOR_API_TOKEN and each
 * person's dashboard token (DASHBOARD_TOKENS). Only digests are kept, and a token is compared
 * with every one of them in constant time, so how long a check takes says nothing about
 * which token matched or how close a guess came.
 *
 * Wrong tokens are counted per address, over HTTP and the socket together. Past
 * FAILED_TOKENS_PER_WINDOW in a window, every check from that address is refused with
 * `rate_limited` until the window ends, the right token included, so guessing stops. A
 * request with no token isn't a guess and isn't counted. The count is in memory, per instance.
 */
export class ApiTokens {
  private readonly known: { digest: Buffer; caller: Caller }[];
  private readonly failures: RateLimiter;
  /** Whether any personal token is configured. Then only a person can decide. */
  readonly personal: boolean;

  constructor(
    config: Pick<Config, 'apiToken' | 'dashboardTokens'>,
    private readonly logger: Logger,
    now?: () => number,
  ) {
    this.known = config.dashboardTokens.map(({ name, sha256 }) => ({
      digest: Buffer.from(sha256, 'hex'),
      caller: { kind: 'person', name },
    }));
    if (config.apiToken) {
      this.known.push({ digest: tokenDigest(config.apiToken), caller: { kind: 'shared' } });
    }
    this.personal = config.dashboardTokens.length > 0;
    this.failures = new RateLimiter(FAILED_TOKENS_PER_WINDOW, FAILED_TOKEN_WINDOW_MS, now);
  }

  /** Who `token` belongs to, or undefined for no token or a wrong one. Counts nothing. */
  identify(token: unknown): Caller | undefined {
    if (typeof token !== 'string' || token === '') return undefined;
    const digest = tokenDigest(token);
    let match: Caller | undefined;
    for (const entry of this.known) {
      // No early exit: every digest is compared whatever matched before it.
      if (timingSafeEqual(digest, entry.digest) && match === undefined) match = entry.caller;
    }
    return match;
  }

  /**
   * Checks the token a request or a handshake from `address` carried: `rate_limited` while
   * the address is past its wrong tokens, `unauthorized` for no token or a wrong one.
   */
  check(token: unknown, address: string): TokenCheck {
    const spent = this.failures.peek(address);
    if (!spent.allowed) {
      return { ok: false, refusal: 'rate_limited', retryAfterMs: spent.retryAfterMs };
    }
    const caller = this.identify(token);
    if (caller !== undefined) return { ok: true, caller };
    if (typeof token === 'string' && token !== '') {
      this.failures.hit(address);
      const after = this.failures.peek(address);
      if (!after.allowed) {
        this.logger.warn(
          { address, retryAfterMs: after.retryAfterMs },
          `${FAILED_TOKENS_PER_WINDOW} wrong API tokens from one address; refusing it until its window ends`,
        );
      }
    }
    return { ok: false, refusal: 'unauthorized', retryAfterMs: 0 };
  }
}
