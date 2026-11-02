import { describe, expect, it } from 'vitest';
import { withRetries } from './retry.ts';
import type {
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  ModelClient,
  ModelError,
} from './types.ts';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const success: CompletionResult = {
  ok: true,
  completion: { content: 'ok', finishReason: 'stop', model: 'm', costUsd: 0 },
};
const failure = (kind: ModelError['kind'], status: number | null = null): CompletionResult => ({
  ok: false,
  error: { kind, status, message: kind },
});

/** A client that answers with `results` in order and records each call's options. */
function scripted(results: CompletionResult[]) {
  const calls: (CompleteOptions | undefined)[] = [];
  const client: ModelClient = {
    complete(_messages, options) {
      calls.push(options);
      const next = results.shift();
      if (next === undefined) throw new Error('out of results');
      return Promise.resolve(next);
    },
  };
  return { client, calls };
}

/** A fake clock: sleeping moves it forward. */
function fakeTime(start = 0) {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('withRetries', () => {
  it('returns the first success without waiting', async () => {
    const { client } = scripted([success]);
    const time = fakeTime();
    expect(await withRetries(client, time).complete(messages)).toEqual(success);
    expect(time.sleeps).toEqual([]);
  });

  it.each([
    ['a rate limit', failure('rate_limited', 429)],
    ['a network error', failure('network')],
    ['a 502', failure('http', 502)],
    ['a 408', failure('http', 408)],
  ])('retries %s with growing backoff', async (_name, transient) => {
    const { client } = scripted([transient, transient, success]);
    const time = fakeTime();
    const result = await withRetries(client, { ...time, baseDelayMs: 100 }).complete(messages);
    expect(result).toEqual(success);
    expect(time.sleeps).toEqual([100, 200]);
  });

  it('gives up after the last attempt and returns its error', async () => {
    const last = failure('http', 503);
    const { client, calls } = scripted([failure('network'), failure('http', 502), last]);
    const time = fakeTime();
    const result = await withRetries(client, { ...time, attempts: 3 }).complete(messages);
    expect(result).toEqual(last);
    expect(calls).toHaveLength(3);
  });

  it.each([
    ['auth', failure('auth', 401)],
    ['credits', failure('credits', 402)],
    ['a bad response', failure('bad_response', 200)],
    ['a 400', failure('http', 400)],
  ])('does not retry %s', async (_name, permanent) => {
    const { client, calls } = scripted([permanent]);
    const result = await withRetries(client, fakeTime()).complete(messages);
    expect(result).toEqual(permanent);
    expect(calls).toHaveLength(1);
  });

  it('keeps every attempt and wait inside the caller timeout', async () => {
    const { client, calls } = scripted([failure('network'), failure('network'), success]);
    const time = fakeTime(1_000);
    const retrying = withRetries(client, { ...time, baseDelayMs: 300 });
    const result = await retrying.complete(messages, { timeoutMs: 1_000 });
    // Attempt 1 gets the whole second; after a 300 ms wait, 700 ms are left. The next wait
    // (600 ms) would leave 100 ms, so it still tries; one more wait would pass the deadline.
    expect(result).toEqual(success);
    expect(calls.map((c) => c?.timeoutMs)).toEqual([1_000, 700, 100]);
  });

  it('stops retrying when the next wait would pass the deadline', async () => {
    const last = failure('network');
    const { client, calls } = scripted([failure('network'), last]);
    const time = fakeTime();
    const retrying = withRetries(client, { ...time, baseDelayMs: 400 });
    const result = await retrying.complete(messages, { timeoutMs: 1_000 });
    expect(result).toEqual(last);
    expect(calls).toHaveLength(2);
    expect(time.sleeps).toEqual([400]);
  });

  it('passes no timeout through when the caller gave none', async () => {
    const { client, calls } = scripted([failure('network'), success]);
    await withRetries(client, fakeTime()).complete(messages);
    expect(calls.map((c) => c?.timeoutMs)).toEqual([undefined, undefined]);
  });
});
