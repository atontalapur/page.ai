import type { CompletionResult, ModelClient } from '@page/model-client';
import { describe, expect, it } from 'vitest';
import { buildClassifier, TriageClassifier } from './classify.ts';

const rulesTitle = 'Hydration failed';

function model(result: CompletionResult): ModelClient {
  return { complete: () => Promise.resolve(result) };
}

const ok = (content: string): CompletionResult => ({
  ok: true,
  completion: { content, finishReason: 'stop', model: 'test', costUsd: 0 },
});

describe('TriageClassifier', () => {
  it('uses a well formed model reply', async () => {
    const classifier = new TriageClassifier(
      model(ok('```json\n{"class":"database","severity":"critical"}\n```')),
      1000,
    );
    await expect(classifier.classify(rulesTitle)).resolves.toEqual({
      class: 'database',
      severity: 'critical',
    });
  });

  it('falls back when the reply is junk', async () => {
    const classifier = new TriageClassifier(model(ok('not json')), 1000);
    await expect(classifier.classify(rulesTitle)).resolves.toEqual({
      class: 'frontend',
      severity: 'medium',
    });
  });

  it('falls back when the model times out', async () => {
    const classifier = new TriageClassifier(
      model({ ok: false, error: { kind: 'aborted', status: null, message: 'timeout' } }),
      1000,
    );
    await expect(classifier.classify(rulesTitle)).resolves.toEqual({
      class: 'frontend',
      severity: 'medium',
    });
  });

  it('classifies from the title when there is no model', async () => {
    const classifier = new TriageClassifier(null, 1000);
    await expect(classifier.classify('relation "orders" does not exist')).resolves.toEqual({
      class: 'database',
      severity: 'critical',
    });
    await expect(classifier.classify('ECONNREFUSED 127.0.0.1:5432')).resolves.toEqual({
      class: 'infra-config',
      severity: 'low',
    });
    await expect(classifier.classify('TypeError in /api/cart')).resolves.toEqual({
      class: 'backend-api',
      severity: 'high',
    });
  });

  it('builds a rules classifier without a key and a model classifier with one', async () => {
    const base = {
      databaseUrl: 'postgres://page:page@localhost:5432/page',
      port: 4000,
      host: '0.0.0.0',
      pgbossSchema: 'pgboss',
      useFakeAdapters: false,
      logLevel: 'info' as const,
      posthogWebhookSecret: undefined,
      triageModel: 'openai/gpt-4o-mini',
      triageTimeoutMs: 1000,
      twilio: undefined,
      notifyTo: [],
      dashboardUrl: 'http://localhost:3000',
    };
    const rules = buildClassifier({ ...base, openRouterApiKey: undefined });
    await expect(rules.classify('Hydration failed')).resolves.toMatchObject({ class: 'frontend' });
    const live = buildClassifier({ ...base, openRouterApiKey: 'sk-test' });
    expect(live).toBeInstanceOf(TriageClassifier);
  });
});
