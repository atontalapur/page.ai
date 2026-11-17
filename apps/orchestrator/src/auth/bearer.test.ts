import { describe, expect, it } from 'vitest';
import { bearerAuthorized } from './bearer.ts';

describe('bearerAuthorized', () => {
  it('accepts the bearer secret and rejects everything else', () => {
    expect(bearerAuthorized('Bearer secret', 'secret')).toBe(true);
    expect(bearerAuthorized('Bearer other', 'secret')).toBe(false);
    expect(bearerAuthorized(undefined, 'secret')).toBe(false);
    expect(bearerAuthorized('Bearer secret', undefined)).toBe(false);
    expect(bearerAuthorized('secret', 'secret')).toBe(false);
  });
});
