import { z } from 'zod';
import type { FetchLike } from './openrouter.ts';
import type { ModelError, ModelErrorKind } from './types.ts';

/**
 * A question with a fixed set of answers. `criteria` maps each answer to what it means; the
 * model picks one and gives every answer a probability.
 */
export interface ChoiceQuestion {
  type: 'choice';
  criteria: Record<string, string>;
}

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface Decision<Q extends string> {
  model: string;
  answers: Record<Q, ChoiceAnswer>;
  costUsd: number;
}

export type DecisionResult<Q extends string> =
  { ok: true; decision: Decision<Q> } | { ok: false; error: ModelError };

/** A decisions model: classifies a state against named choice questions. */
export interface Decider {
  decide<Q extends string>(
    state: string | Record<string, unknown>,
    questions: Record<Q, ChoiceQuestion>,
    options?: { timeoutMs?: number },
  ): Promise<DecisionResult<Q>>;
}

export interface OpenRouterDeciderOptions {
  apiKey: string;
  /** A decisions model id, e.g. `typesafe/jev-1.14`. */
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const answerSchema = z.object({
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});

const bodySchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ cost: z.number().optional() }).optional(),
});

const KIND_BY_STATUS: Record<number, ModelErrorKind> = {
  401: 'auth',
  402: 'credits',
  429: 'rate_limited',
};

const failure = (kind: ModelErrorKind, status: number | null, message: string) =>
  ({ ok: false, error: { kind, status, message } }) as const;

/** OpenRouter's /api/alpha/decisions endpoint, which decisions models answer on. */
export class OpenRouterDecider implements Decider {
  private readonly options: Required<OpenRouterDeciderOptions>;

  constructor(options: OpenRouterDeciderOptions) {
    this.options = {
      baseUrl: 'https://openrouter.ai/api/alpha',
      timeoutMs: 15_000,
      fetch: (url, init) => fetch(url, init),
      ...options,
    };
  }

  async decide<Q extends string>(
    state: string | Record<string, unknown>,
    questions: Record<Q, ChoiceQuestion>,
    { timeoutMs = this.options.timeoutMs }: { timeoutMs?: number } = {},
  ): Promise<DecisionResult<Q>> {
    let res: Response;
    try {
      res = await this.options.fetch(`${this.options.baseUrl}/decisions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: this.options.model, state, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return failure('network', null, String(error));
    }
    const text = await res.text();
    if (!res.ok) {
      return failure(KIND_BY_STATUS[res.status] ?? 'http', res.status, text.slice(0, 500));
    }
    let parsed: z.infer<typeof bodySchema>;
    try {
      parsed = bodySchema.parse(JSON.parse(text));
    } catch {
      return failure('bad_response', res.status, text.slice(0, 500));
    }
    for (const [name, question] of Object.entries<ChoiceQuestion>(questions)) {
      const answer = parsed.answers[name];
      if (answer === undefined || !(answer.choice in question.criteria)) {
        return failure('bad_response', res.status, `no valid answer to ${name}`);
      }
    }
    return {
      ok: true,
      decision: {
        model: parsed.model,
        answers: parsed.answers,
        costUsd: parsed.usage?.cost ?? 0,
      },
    };
  }
}
