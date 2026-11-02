import { describe, expect, it } from 'vitest';
import { OpenRouterClient, type FetchLike } from './openrouter.ts';
import type { ChatMessage } from './types.ts';

const messages: ChatMessage[] = [
  { role: 'system', content: 'be brief' },
  { role: 'user', content: 'hi' },
];

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown, seen: Captured[] = []): FetchLike {
  return (url, init) => {
    seen.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return Promise.resolve(
      new Response(text, { status, headers: { 'content-type': 'application/json' } }),
    );
  };
}

const completionBody = {
  model: 'openai/gpt-5-mini',
  choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.0004 },
};

function client(fetch: FetchLike) {
  return new OpenRouterClient({ apiKey: 'sk-test', model: 'openai/gpt-5-mini', fetch });
}

describe('OpenRouterClient', () => {
  it('posts the messages and model to the chat completions endpoint', async () => {
    const seen: Captured[] = [];
    await client(fakeFetch(200, completionBody, seen)).complete(messages);

    expect(seen).toHaveLength(1);
    const [{ url, init }] = seen as [Captured];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'openai/gpt-5-mini',
      messages,
      usage: { include: true },
    });
  });

  it('merges extra body fields into the request', async () => {
    const seen: Captured[] = [];
    const c = new OpenRouterClient({
      apiKey: 'k',
      model: 'm',
      fetch: fakeFetch(200, completionBody, seen),
      extraBody: { temperature: 0 },
    });
    await c.complete(messages);
    expect(JSON.parse(seen[0]!.init.body as string)).toMatchObject({ temperature: 0, model: 'm' });
  });

  it('returns the content, finish reason, model and cost', async () => {
    const result = await client(fakeFetch(200, completionBody)).complete(messages);
    expect(result).toEqual({
      ok: true,
      completion: {
        content: 'hello',
        finishReason: 'stop',
        model: 'openai/gpt-5-mini',
        costUsd: 0.0004,
      },
    });
  });

  it('treats null content and a missing cost as empty and zero', async () => {
    const body = {
      model: 'm',
      choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'length' }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    };
    const result = await client(fakeFetch(200, body)).complete(messages);
    expect(result).toEqual({
      ok: true,
      completion: { content: '', finishReason: 'length', model: 'm', costUsd: 0 },
    });
  });

  it.each([
    [401, 'auth'],
    [402, 'credits'],
    [429, 'rate_limited'],
    [502, 'http'],
  ] as const)('maps HTTP %i to a %s error', async (status, kind) => {
    const body = { error: { code: status, message: 'nope' } };
    const result = await client(fakeFetch(status, body)).complete(messages);
    expect(result).toEqual({ ok: false, error: { kind, status, message: 'nope' } });
  });

  it('falls back to the body text when an error response is not JSON', async () => {
    const result = await client(fakeFetch(500, 'upstream exploded')).complete(messages);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'http', status: 500, message: 'upstream exploded' },
    });
  });

  it('reports an error sent inside a 200 response', async () => {
    const body = { error: { code: 502, message: 'provider died mid-stream' } };
    const result = await client(fakeFetch(200, body)).complete(messages);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'http', status: 502, message: 'provider died mid-stream' },
    });
  });

  it('reports a 200 response with no choices as a bad response', async () => {
    const result = await client(fakeFetch(200, { model: 'm', choices: [] })).complete(messages);
    expect(result).toMatchObject({ ok: false, error: { kind: 'bad_response', status: 200 } });
  });

  it('reports a 200 response that is not JSON as a bad response', async () => {
    const result = await client(fakeFetch(200, '<html>')).complete(messages);
    expect(result).toMatchObject({ ok: false, error: { kind: 'bad_response', status: 200 } });
  });

  it('reports a fetch that throws as a network error', async () => {
    const failing: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const result = await client(failing).complete(messages);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'network', status: null, message: 'fetch failed' },
    });
  });

  it('aborts the request after the timeout', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const c = new OpenRouterClient({ apiKey: 'k', model: 'm', fetch: hanging, timeoutMs: 5 });
    const result = await c.complete(messages);
    expect(result).toMatchObject({ ok: false, error: { kind: 'network', status: null } });
  });
});
