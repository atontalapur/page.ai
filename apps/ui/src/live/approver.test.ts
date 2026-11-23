// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readApproverName, saveApproverName } from './approver';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('approver name storage', () => {
  it('keeps the name in localStorage, so every tab in the browser decides under it', () => {
    expect(readApproverName()).toBeNull();
    saveApproverName('Arjun');
    expect(readApproverName()).toBe('Arjun');
    expect(sessionStorage.length).toBe(0);
  });

  it('reads a name the server would refuse as none', () => {
    localStorage.setItem('page-ai-approver-name', 'system:timed_out');
    expect(readApproverName()).toBeNull();
  });

  it('carries on when storage throws', () => {
    for (const method of ['getItem', 'setItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
    }
    expect(() => saveApproverName('Arjun')).not.toThrow();
    expect(readApproverName()).toBeNull();
  });
});
