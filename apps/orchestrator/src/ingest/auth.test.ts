import { describe, expect, it } from 'vitest';
import { webhookAuthorized } from './auth.ts';

describe('webhookAuthorized', () => {
  it('accepts the bearer secret and rejects everything else', () => {
    expect(webhookAuthorized('Bearer secret', 'secret')).toBe(true);
    expect(webhookAuthorized('Bearer other', 'secret')).toBe(false);
    expect(webhookAuthorized(undefined, 'secret')).toBe(false);
    expect(webhookAuthorized('Bearer secret', undefined)).toBe(false);
    expect(webhookAuthorized('secret', 'secret')).toBe(false);
  });
});
