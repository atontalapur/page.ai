import { describe, expect, it } from 'vitest';
import { scenarioKind, scenarioMetaSchema } from './scenario.ts';

const valid = {
  class: 'backend-api',
  expectedTier: 1,
  description: 'Cart total skips the last item',
  report: 'GET /cart returned 500\n\nError: boom\n    at cart.ts:1:1',
};

describe('scenarioMetaSchema', () => {
  it('accepts a valid meta.json', () => {
    expect(scenarioMetaSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an unknown class or tier', () => {
    expect(() => scenarioMetaSchema.parse({ ...valid, class: 'network' })).toThrow();
    expect(() => scenarioMetaSchema.parse({ ...valid, expectedTier: 4 })).toThrow();
  });

  it('rejects an empty or multi-line description', () => {
    expect(() => scenarioMetaSchema.parse({ ...valid, description: '  ' })).toThrow();
    expect(() => scenarioMetaSchema.parse({ ...valid, description: 'a\nb' })).toThrow();
  });

  it('rejects a missing report', () => {
    expect(() => scenarioMetaSchema.parse({ ...valid, report: undefined })).toThrow();
  });

  it('rejects an empty or very long report', () => {
    expect(() => scenarioMetaSchema.parse({ ...valid, report: ' \n ' })).toThrow();
    expect(() => scenarioMetaSchema.parse({ ...valid, report: 'x'.repeat(4_001) })).toThrow();
  });

  it('accepts frameLines keyed path:line', () => {
    const meta = { ...valid, frameLines: { 'apps/demo-app/a.ts:3': '  return f();' } };
    expect(scenarioMetaSchema.parse(meta)).toEqual(meta);
  });

  it('rejects a frameLines key without a line', () => {
    for (const key of ['apps/demo-app/a.ts', 'apps/demo-app/a.ts:0', 'a b.ts:1']) {
      expect(() => scenarioMetaSchema.parse({ ...valid, frameLines: { [key]: 'x' } })).toThrow();
    }
  });

  it('rejects unknown keys', () => {
    expect(() => scenarioMetaSchema.parse({ ...valid, fix: 'x' })).toThrow();
  });
});

describe('scenarioKind', () => {
  it('is code for Tier 1 and 2 and ops for Tier 3', () => {
    expect(scenarioKind({ expectedTier: 1 })).toBe('code');
    expect(scenarioKind({ expectedTier: 2 })).toBe('code');
    expect(scenarioKind(scenarioMetaSchema.parse({ ...valid, expectedTier: 3 }))).toBe('ops');
  });
});
