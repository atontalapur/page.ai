import { describe, expect, it } from 'vitest';
import { scenarioMetaSchema } from './scenario.ts';

const valid = {
  class: 'backend-api',
  expectedTier: 1,
  description: 'Cart total skips the last item',
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

  it('accepts a multi-line report', () => {
    const report =
      'GET / returned 500\n\nRangeError: Invalid currency code : US\n    at money.ts:1:13';
    expect(scenarioMetaSchema.parse({ ...valid, report })).toEqual({ ...valid, report });
  });

  it('rejects an empty or very long report', () => {
    expect(() => scenarioMetaSchema.parse({ ...valid, report: ' \n ' })).toThrow();
    expect(() => scenarioMetaSchema.parse({ ...valid, report: 'x'.repeat(4_001) })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => scenarioMetaSchema.parse({ ...valid, fix: 'x' })).toThrow();
  });
});
