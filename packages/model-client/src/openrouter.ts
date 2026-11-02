import { z } from 'zod';
import type { ChatMessage, CompletionResult, ModelClient, ModelErrorKind } from './types.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenRouterClientOptions {
  apiKey: string;
  /** An OpenRouter model id, e.g. `openai/gpt-5-mini`. */
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Extra request fields such as `temperature`; `model` and `messages` win over these. */
  extraBody?: Record<string, unknown>;
  fetch?: FetchLike;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 120_000;

const errorBodySchema = z.object({
  error: z.object({ code: z.number().optional(), message: z.string() }),
});

const completionBodySchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable(),
      }),
    )
    .min(1),
  usage: z.object({ cost: z.number().optional() }).optional(),
});

const KIND_BY_STATUS: Record<number, ModelErrorKind> = {
  401: 'auth',
  402: 'credits',
  429: 'rate_limited',
};

const failure = (kind: ModelErrorKind, status: number | null, message: string) =>
  ({ ok: false, error: { kind, status, message } }) as const;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Chat completions over OpenRouter. Request errors come back with a matching HTTP status;
 * an error raised while the model is answering comes back as a 200 with an `error` body.
 */
export class OpenRouterClient implements ModelClient {
  private readonly options: Required<Omit<OpenRouterClientOptions, 'extraBody'>> & {
    extraBody: Record<string, unknown>;
  };

  constructor(options: OpenRouterClientOptions) {
    this.options = {
      baseUrl: DEFAULT_BASE_URL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      extraBody: {},
      fetch: globalThis.fetch,
      ...options,
    };
  }

  async complete(messages: readonly ChatMessage[]): Promise<CompletionResult> {
    const { apiKey, model, baseUrl, timeoutMs, extraBody, fetch } = this.options;

    let response: Response;
    let text: string;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...extraBody, model, messages, usage: { include: true } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (e) {
      return failure('network', null, e instanceof Error ? e.message : String(e));
    }

    const body = parseJson(text);
    const errorBody = errorBodySchema.safeParse(body);
    if (!response.ok || errorBody.success) {
      const status = errorBody.data?.error.code ?? response.status;
      const message = errorBody.data?.error.message ?? text;
      return failure(KIND_BY_STATUS[status] ?? 'http', status, message);
    }

    const parsed = completionBodySchema.safeParse(body);
    if (!parsed.success) {
      return failure('bad_response', response.status, `unexpected response: ${text.slice(0, 500)}`);
    }
    const [choice] = parsed.data.choices as [(typeof parsed.data.choices)[number]];
    return {
      ok: true,
      completion: {
        content: choice.message.content ?? '',
        finishReason: choice.finish_reason,
        model: parsed.data.model,
        costUsd: parsed.data.usage?.cost ?? 0,
      },
    };
  }
}
