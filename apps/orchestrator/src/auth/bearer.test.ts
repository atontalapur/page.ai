import { describe, expect, it } from 'vitest';
import { bearerAuthorized, tokenAuthorized } from './bearer.ts';

describe('bearerAuthorized', () => {
  it('accepts the bearer secret and rejects everything else', () => {
    expect(bearerAuthorized('Bearer secret', 'secret')).toBe(true);
    expect(bearerAuthorized('Bearer other', 'secret')).toBe(false);
    expect(bearerAuthorized(undefined, 'secret')).toBe(false);
    expect(bearerAuthorized('Bearer secret', undefined)).toBe(false);
    expect(bearerAuthorized('secret', 'secret')).toBe(false);
  });
});

describe('tokenAuthorized', () => {
  it('accepts the bare secret and rejects everything else', () => {
    expect(tokenAuthorized('secret', 'secret')).toBe(true);
    expect(tokenAuthorized('other', 'secret')).toBe(false);
    expect(tokenAuthorized('', 'secret')).toBe(false);
    expect(tokenAuthorized(undefined, 'secret')).toBe(false);
    expect(tokenAuthorized(['secret'], 'secret')).toBe(false);
    expect(tokenAuthorized('secret', undefined)).toBe(false);
  });
});
