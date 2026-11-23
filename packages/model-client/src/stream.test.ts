import { describe, expect, it } from 'vitest';
import { OpenRouterClient } from './openrouter.ts';

/** A fetch that answers with `events` as server-sent events, one chunk per two events. */
function sse(events: (object | string)[], status = 200) {
  const lines = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += 2) chunks.push(lines.slice(i, i + 2).join(''));
  return () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const c of [': OPENROUTER PROCESSING\n\n', ...chunks]) {
              controller.enqueue(new TextEncoder().encode(c));
            }
            controller.close();
          },
        }),
        { status },
      ),
    );
}

const client = (fetch: (url: string, init: RequestInit) => Promise<Response>) =>
  new OpenRouterClient({ apiKey: 'k', model: 'deepseek/deepseek-v4.1-flash', fetch });

describe('OpenRouterClient streaming', () => {
  it('hands each piece to onDelta and returns the whole reply with its cost', async () => {
    const deltas: string[] = [];
    let body: { stream?: boolean } = {};
    const result = await client((url, init) => {
      body = JSON.parse(init.body as string) as { stream?: boolean };
      return sse([
        {
          model: 'deepseek/deepseek-v4.1-flash',
          choices: [{ delta: { reasoning: 'Look at cart. ' } }],
        },
        { choices: [{ delta: { content: 'THOUGHT: read ' } }] },
        { choices: [{ delta: { content: 'the cart' }, finish_reason: 'stop' }] },
        { choices: [], usage: { cost: 0.0012 } },
        '[DONE]',
      ])();
    }).complete([{ role: 'user', content: 'fix it' }], {
      onDelta: ({ text, kind }) => deltas.push(`${kind}:${text}`),
    });

    expect(body.stream).toBe(true);
    expect(deltas).toEqual([
      'reasoning:Look at cart. ',
      'content:THOUGHT: read ',
      'content:the cart',
    ]);
    expect(result).toEqual({
      ok: true,
      completion: {
        content: 'THOUGHT: read the cart',
        finishReason: 'stop',
        model: 'deepseek/deepseek-v4.1-flash',
        costUsd: 0.0012,
        reasoning: 'Look at cart. ',
      },
    });
  });

  it('fails on an error inside the stream, and on a stream with no cost', async () => {
    const onDelta = () => undefined;
    const broken = await client(sse([{ error: { code: 429, message: 'slow down' } }])).complete(
      [],
      { onDelta },
    );
    expect(broken).toMatchObject({ ok: false, error: { kind: 'rate_limited', status: 429 } });
    const unpriced = await client(sse([{ choices: [{ delta: { content: 'hi' } }] }])).complete([], {
      onDelta,
    });
    expect(unpriced).toMatchObject({ ok: false, error: { kind: 'bad_response' } });
  });

  it('maps an HTTP error before the stream starts', async () => {
    const result = await client(() =>
      Promise.resolve(
        Response.json({ error: { code: 402, message: 'no credit' } }, { status: 402 }),
      ),
    ).complete([], { onDelta: () => undefined });
    expect(result).toMatchObject({ ok: false, error: { kind: 'credits', status: 402 } });
  });

  it('reports a network failure', async () => {
    const result = await client(() => Promise.reject(new Error('reset'))).complete([], {
      onDelta: () => undefined,
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'network' } });
  });
});
