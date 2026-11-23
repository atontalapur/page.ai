import { bugClassSchema, clip, severitySchema } from '@page/contracts';
import { OpenRouterClient, type ModelClient, type ModelError } from '@page/model-client';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { classifyByRules, type TriageInput, type Verdict } from './rules.ts';

export type { TriageInput, Verdict } from './rules.ts';

const verdictSchema: z.ZodType<Verdict> = z.object({
  class: bugClassSchema,
  severity: severitySchema,
});

/** A verdict and the path that reached it, for the triage log line. */
export interface Triage extends Verdict {
  by: 'model' | 'rules';
  /** Why the rules ran though a model is configured. */
  fallback?: string;
}

// The model's error or reply goes into a log line, so it is cut short.
const FALLBACK_MAX = 200;

function modelFailure({ kind, status, message }: ModelError): string {
  return clip(`${kind}${status === null ? '' : ` ${status}`}: ${message}`, FALLBACK_MAX);
}

const SYSTEM = [
  'Classify one production exception for an on-call pipeline.',
  'Reply with JSON only, no markdown: {"class":"frontend"|"backend-api"|"database"|"infra-config","severity":"low"|"medium"|"high"|"critical"}.',
  'class is where the bug lives. severity is how badly it pages someone.',
].join(' ');

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
 * reply that is not the JSON contract falls back to rules over the title and report.
 */
export class TriageClassifier {
  constructor(
    private readonly model: ModelClient | null,
    private readonly timeoutMs: number,
  ) {}

  async classify(input: TriageInput): Promise<Triage> {
    if (!this.model) return { ...classifyByRules(input), by: 'rules' };
    const result = await this.model.complete(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: input.title },
      ],
      { timeoutMs: this.timeoutMs },
    );
    if (!result.ok) {
      return { ...classifyByRules(input), by: 'rules', fallback: modelFailure(result.error) };
    }
    const verdict = parseVerdict(result.completion.content);
    if (verdict) return { ...verdict, by: 'model' };
    const reply = clip(result.completion.content, FALLBACK_MAX);
    return { ...classifyByRules(input), by: 'rules', fallback: `reply is not a verdict: ${reply}` };
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
