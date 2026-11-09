import type { CompletionResult, ModelClient, ModelError } from './types.ts';

export interface RetryOptions {
  /** Total tries, the first one included. */
  attempts?: number;
  /** Wait before the second try; it doubles after each failure. */
  baseDelayMs?: number;
  /** Should resolve early once `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

// Worth another try: the provider was busy, slow or briefly down. Auth, credits, a 4xx and
// a malformed response come back the same way every time.
function isTransient({ kind, status }: ModelError): boolean {
  if (kind === 'rate_limited' || kind === 'network') return true;
  return kind === 'http' && status !== null && (status === 408 || status >= 500);
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Retries transient model errors with exponential backoff. A caller's `timeoutMs` bounds
 * the whole call: each attempt gets what is left, and no wait runs past the deadline.
 */
export function withRetries(client: ModelClient, options: RetryOptions = {}): ModelClient {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;

  return {
    async complete(messages, callOptions = {}) {
      const deadline =
        callOptions.timeoutMs === undefined ? Infinity : now() + callOptions.timeoutMs;
      for (let attempt = 1; ; attempt++) {
        const result: CompletionResult = await client.complete(
          messages,
          deadline === Infinity ? callOptions : { ...callOptions, timeoutMs: deadline - now() },
        );
        if (result.ok || !isTransient(result.error)) return result;
        if (callOptions.signal?.aborted) return result;

        const delay = baseDelayMs * 2 ** (attempt - 1);
        if (attempt >= attempts || now() + delay >= deadline) return result;
        await sleep(delay, callOptions.signal);
        // A kill during the wait ends the call now, not after one more doomed attempt.
        if (callOptions.signal?.aborted) return result;
      }
    },
  };
}
