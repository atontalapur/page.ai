import { describe, expect, it } from 'vitest';
import { OpenRouterDecider } from './decisions.ts';
import { cosine, HashEmbedder, OpenRouterEmbedder } from './embeddings.ts';

const reply = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const questions = { tier: { type: 'choice' as const, criteria: { '1': 'code', '3': 'settings' } } };

describe('OpenRouterDecider', () => {
  it("sends the state and questions to the decisions endpoint and reads jev's answer", async () => {
    let sent: { url: string; body: unknown } | undefined;
    const decider = new OpenRouterDecider({
      apiKey: 'k',
      model: 'typesafe/jev-1.14',
      fetch: (url, init) => {
        sent = { url, body: JSON.parse(init.body as string) as unknown };
        return reply(200, {
          model: 'typesafe/jev-1.14-20261014',
          answers: {
            tier: {
              type: 'choice',
              choice: '3',
              probabilities: { '1': 0.1, '3': 0.9 },
              confidence: 0.8,
            },
          },
          usage: { cost: 0.00002 },
        })();
      },
    });
    const result = await decider.decide({ report: 'boom' }, questions);
    expect(sent?.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(sent?.body).toEqual({
      model: 'typesafe/jev-1.14',
      state: { report: 'boom' },
      questions,
    });
    expect(result).toEqual({
      ok: true,
      decision: {
        model: 'typesafe/jev-1.14-20261014',
        answers: {
          tier: {
            choice: '3',
            probabilities: { '1': 0.1, '3': 0.9 },
            confidence: 0.8,
          },
        },
        costUsd: 0.00002,
      },
    });
  });

  it('refuses an answer outside the criteria, and maps HTTP errors', async () => {
    const off = new OpenRouterDecider({
      apiKey: 'k',
      model: 'm',
      fetch: reply(200, {
        model: 'm',
        answers: { tier: { choice: '2', probabilities: {}, confidence: 1 } },
      }),
    });
    expect(await off.decide('x', questions)).toMatchObject({
      ok: false,
      error: { kind: 'bad_response' },
    });
    const broke = new OpenRouterDecider({
      apiKey: 'k',
      model: 'm',
      fetch: reply(402, { error: 'no credit' }),
    });
    expect(await broke.decide('x', questions)).toMatchObject({
      ok: false,
      error: { kind: 'credits', status: 402 },
    });
  });
});

describe('embedders', () => {
  it('asks OpenRouter for vectors of the set size, in input order', async () => {
    const embedder = new OpenRouterEmbedder({
      apiKey: 'k',
      model: 'qwen/qwen3-embedding-8b',
      dimensions: 2,
      fetch: reply(200, {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    });
    expect(await embedder.embed(['a', 'b'])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it('puts texts that share words near each other', async () => {
    const [a, b, c] = await new HashEmbedder().embed([
      'cart shipping total',
      'shipping total',
      'login form',
    ]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });
});
