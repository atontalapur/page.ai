// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearToken, readToken, saveToken } from './token';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('token storage', () => {
  it('keeps the token in sessionStorage until cleared', () => {
    expect(readToken()).toBeNull();
    saveToken('s3cret');
    expect(readToken()).toBe('s3cret');
    expect(localStorage.length).toBe(0);
    clearToken();
    expect(readToken()).toBeNull();
  });

  it('carries on when storage throws', () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
    }
    expect(() => saveToken('s3cret')).not.toThrow();
    expect(readToken()).toBeNull();
    expect(() => clearToken()).not.toThrow();
  });
});
