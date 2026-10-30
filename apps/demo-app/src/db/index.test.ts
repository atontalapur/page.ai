import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb } from './index.ts';

describe('getDb', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('creates one pool per process', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://page:page@localhost:5432/demo');
    expect(getDb()).toBe(getDb());
  });
});
