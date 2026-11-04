import { z } from 'zod';
import type {
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  ModelClient,
  ModelErrorKind,
} from './types.ts';

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
  private readonly options: Required<OpenRouterClientOptions>;

  constructor(options: OpenRouterClientOptions) {
    // Field by field, so an option passed as undefined keeps its default.
    this.options = {
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      extraBody: options.extraBody ?? {},
      fetch: options.fetch ?? globalThis.fetch,
    };
  }

  async complete(
    messages: readonly ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<CompletionResult> {
    const { apiKey, model, baseUrl, extraBody, fetch } = this.options;
    const timeoutMs = Math.min(this.options.timeoutMs, options.timeoutMs ?? Infinity);

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
    // Without a cost the agent's cost limit can't fire, so a run could spend unchecked.
    const costUsd = parsed.data.usage?.cost;
    if (costUsd === undefined) {
      return failure(
        'bad_response',
        response.status,
        'the response has no usage.cost, so the cost limit cannot be enforced',
      );
    }
    return {
      ok: true,
      completion: {
        content: choice.message.content ?? '',
        finishReason: choice.finish_reason,
        model: parsed.data.model,
        costUsd,
      },
    };
  }
}
