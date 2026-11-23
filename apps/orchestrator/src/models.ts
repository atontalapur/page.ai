import {
  HashEmbedder,
  OpenRouterDecider,
  OpenRouterEmbedder,
  type Decider,
  type Embedder,
} from '@page/model-client';
import type { Config } from './config.ts';

/** jev on OpenRouter, or null without a key, in which case the rules decide. */
export function buildDecider(config: Config): Decider | null {
  if (config.useFakeAdapters || !config.openRouterApiKey) return null;
  return new OpenRouterDecider({ apiKey: config.openRouterApiKey, model: config.jevModel });
}

/**
 * The embedding model on OpenRouter. Without a key, word-hash vectors, so the knowledge
 * graph still works offline and in tests, with rougher search.
 */
export function buildEmbedder(config: Config): Embedder {
  if (config.useFakeAdapters || !config.openRouterApiKey) return new HashEmbedder();
  return new OpenRouterEmbedder({
    apiKey: config.openRouterApiKey,
    model: config.embeddingModel,
  });
}
