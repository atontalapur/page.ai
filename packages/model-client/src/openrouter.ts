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
        message: z.object({
          content: z.string().nullable(),
          reasoning: z.string().nullable().optional(),
        }),
        finish_reason: z.string().nullable(),
      }),
    )
    .min(1),
  usage: z.object({ cost: z.number().optional() }).optional(),
});

// One server-sent event of a streamed completion: a piece of a choice, the usage at the end,
// or an error.
const streamEventSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullable().optional(),
            reasoning: z.string().nullable().optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: z.object({ cost: z.number().optional() }).optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
});

const KIND_BY_STATUS: Record<number, ModelErrorKind> = {
  401: 'auth',
  402: 'credits',
  429: 'rate_limited',
};

const signalFor = (timeoutMs: number, signal: AbortSignal | undefined) =>
  signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]);

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
    if (options.onDelta) return this.stream(messages, options, timeoutMs, options.onDelta);

    let response: Response;
    let text: string;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...extraBody, model, messages, usage: { include: true } }),
        signal: signalFor(timeoutMs, options.signal),
      });
      text = await response.text();
    } catch (e) {
      if (options.signal?.aborted) return failure('aborted', null, 'the call was cancelled');
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
        ...(choice.message.reasoning ? { reasoning: choice.message.reasoning } : {}),
      },
    };
  }

  /** complete() over OpenRouter's server-sent events, handing each piece to `onDelta`. */
  private async stream(
    messages: readonly ChatMessage[],
    options: CompleteOptions,
    timeoutMs: number,
    onDelta: NonNullable<CompleteOptions['onDelta']>,
  ): Promise<CompletionResult> {
    const { apiKey, model, baseUrl, extraBody, fetch } = this.options;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...extraBody,
          model,
          messages,
          usage: { include: true },
          stream: true,
        }),
        signal: signalFor(timeoutMs, options.signal),
      });
    } catch (e) {
      if (options.signal?.aborted) return failure('aborted', null, 'the call was cancelled');
      return failure('network', null, e instanceof Error ? e.message : String(e));
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      const errorBody = errorBodySchema.safeParse(parseJson(text));
      const status = errorBody.data?.error.code ?? response.status;
      return failure(
        KIND_BY_STATUS[status] ?? 'http',
        status,
        errorBody.data?.error.message ?? text,
      );
    }

    let content = '';
    let reasoning = '';
    let finishReason: string | null = null;
    let answeredBy = model;
    let costUsd: number | undefined;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice('data:'.length).trim();
          if (data === '[DONE]') continue;
          const event = streamEventSchema.safeParse(parseJson(data));
          if (!event.success) continue;
          if (event.data.error) {
            const status = event.data.error.code ?? response.status;
            return failure(KIND_BY_STATUS[status] ?? 'http', status, event.data.error.message);
          }
          if (event.data.model) answeredBy = event.data.model;
          if (event.data.usage?.cost !== undefined) costUsd = event.data.usage.cost;
          const choice = event.data.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const piece = choice.delta?.content;
          if (piece) {
            content += piece;
            onDelta({ text: piece, kind: 'content' });
          }
          const thought = choice.delta?.reasoning;
          if (thought) {
            reasoning += thought;
            onDelta({ text: thought, kind: 'reasoning' });
          }
        }
      }
    } catch (e) {
      if (options.signal?.aborted) return failure('aborted', null, 'the call was cancelled');
      return failure('network', null, e instanceof Error ? e.message : String(e));
    }
    // Without a cost the agent's cost limit can't fire, so a run could spend unchecked.
    if (costUsd === undefined) {
      return failure(
        'bad_response',
        response.status,
        'the stream had no usage.cost, so the cost limit cannot be enforced',
      );
    }
    return {
      ok: true,
      completion: {
        content,
        finishReason,
        model: answeredBy,
        costUsd,
        ...(reasoning ? { reasoning } : {}),
      },
    };
  }
}
