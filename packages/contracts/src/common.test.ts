import { describe, expect, it } from 'vitest';
import { clip } from './common.ts';

describe('clip', () => {
  it('keeps text that fits and cuts longer text to the cap with an ellipsis', () => {
    expect(clip('abcde', 5)).toBe('abcde');
    expect(clip('abcdef', 5)).toBe('ab...');
    expect(clip('abcdef', 5)).toHaveLength(5);
  });
});
