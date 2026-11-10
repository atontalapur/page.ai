import { bugClassSchema, severitySchema, type BugClass, type Severity } from '@page/contracts';
import { OpenRouterClient, type ModelClient } from '@page/model-client';
import { z } from 'zod';
import type { Config } from '../config.ts';

const verdictSchema = z.object({
  class: bugClassSchema,
  severity: severitySchema,
});

export type Verdict = z.infer<typeof verdictSchema>;

const SYSTEM = [
  'Classify one production exception for an on-call pipeline.',
  'Reply with JSON only, no markdown: {"class":"frontend"|"backend-api"|"database"|"infra-config","severity":"low"|"medium"|"high"|"critical"}.',
  'class is where the bug lives. severity is how badly it pages someone.',
].join(' ');

function classifyByRules(title: string): Verdict {
  const text = title.toLowerCase();
  let klass: BugClass = 'backend-api';
  if (/relation|postgres|sql|column|constraint|duplicate key/.test(text)) klass = 'database';
  else if (/econnrefused|eaddrinuse|enoent|config|environment variable|missing env/.test(text)) {
    klass = 'infra-config';
  } else if (/react|hydration|window is not defined|tsx|next\/image/.test(text)) klass = 'frontend';

  let severity: Severity = 'high';
  if (klass === 'database' || /fatal|payment|checkout/.test(text)) severity = 'critical';
  else if (klass === 'frontend') severity = 'medium';
  else if (klass === 'infra-config') severity = 'low';
  return { class: klass, severity };
}

function parseVerdict(content: string): Verdict | undefined {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const parsed = verdictSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Class and severity from a cheap model. A missing model, a failed call, a timeout or a
 * reply that is not the JSON contract falls back to rules over the exception title.
 */
export class TriageClassifier {
  constructor(
    private readonly model: ModelClient | null,
    private readonly timeoutMs: number,
  ) {}

  async classify(title: string): Promise<Verdict> {
    if (!this.model) return classifyByRules(title);
    const result = await this.model.complete(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: title },
      ],
      { timeoutMs: this.timeoutMs },
    );
    if (!result.ok) return classifyByRules(title);
    return parseVerdict(result.completion.content) ?? classifyByRules(title);
  }
}

/** Rules only when adapters are fake or no OpenRouter key is set. */
export function buildClassifier(config: Config): TriageClassifier {
  if (config.useFakeAdapters || !config.openRouterApiKey) {
    return new TriageClassifier(null, config.triageTimeoutMs);
  }
  return new TriageClassifier(
    new OpenRouterClient({
      apiKey: config.openRouterApiKey,
      model: config.triageModel,
      timeoutMs: config.triageTimeoutMs,
    }),
    config.triageTimeoutMs,
  );
}
