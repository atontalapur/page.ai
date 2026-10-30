import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('accepts a postgres url', () => {
    const url = 'postgres://page:page@localhost:5432/demo';
    expect(loadConfig({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('rejects a missing or non-postgres url', () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x@localhost/demo' })).toThrow();
  });
});
