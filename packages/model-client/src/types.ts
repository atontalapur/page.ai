export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface Completion {
  content: string;
  /** Why the model stopped: `stop`, `length` (hit the token limit), and so on. */
  finishReason: string | null;
  /** The model that answered, which may differ from the one asked for. */
  model: string;
  costUsd: number;
}

export type ModelErrorKind =
  'auth' | 'credits' | 'rate_limited' | 'http' | 'network' | 'bad_response' | 'aborted';

export interface ModelError {
  kind: ModelErrorKind;
  /** HTTP status, or the code inside an error body; null when no response arrived. */
  status: number | null;
  message: string;
}

/** Expected failures travel as values, as in toolkit's `Result`. */
export type CompletionResult =
  { ok: true; completion: Completion } | { ok: false; error: ModelError };

export interface CompleteOptions {
  /** Give up after this long, even if the client's own timeout is longer. */
  timeoutMs?: number;
  /** Cancels the call, such as when a run is killed. It then fails as `aborted`. */
  signal?: AbortSignal;
}

/** The one way the agent talks to a model. */
export interface ModelClient {
  complete(messages: readonly ChatMessage[], options?: CompleteOptions): Promise<CompletionResult>;
}
