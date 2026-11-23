import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FetchLike } from './openrouter.ts';

/** Turns text into vectors of `dimensions` numbers, the same model for writes and queries. */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface OpenRouterEmbedderOptions {
  apiKey: string;
  /** An embedding model id, e.g. `qwen/qwen3-embedding-8b`. */
  model: string;
  dimensions?: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const bodySchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
});

/** OpenRouter's /embeddings endpoint. Throws on any failure: a write without it is refused. */
export class OpenRouterEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly options: Required<OpenRouterEmbedderOptions>;

  constructor(options: OpenRouterEmbedderOptions) {
    this.options = {
      dimensions: 1024,
      baseUrl: 'https://openrouter.ai/api/v1',
      timeoutMs: 30_000,
      fetch: (url, init) => fetch(url, init),
      ...options,
    };
    this.dimensions = this.options.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.options.fetch(`${this.options.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        input: texts,
        dimensions: this.dimensions,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`embeddings answered ${res.status}: ${text.slice(0, 300)}`);
    const { data } = bodySchema.parse(JSON.parse(text));
    const vectors = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== this.dimensions)) {
      throw new Error('embeddings answered with the wrong number or size of vectors');
    }
    return vectors;
  }
}

/**
 * Deterministic vectors from word hashes, for tests and fake adapters: texts that share
 * words land close together, so search still ranks them sensibly.
 */
export class HashEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions = 64) {
    this.dimensions = dimensions;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Array<number>(this.dimensions).fill(0);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const slot = createHash('sha256').update(word).digest().readUInt32BE(0);
          vector[slot % this.dimensions]! += 1;
        }
        return vector;
      }),
    );
  }
}

/** Cosine similarity; 0 when either vector is all zeros. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
