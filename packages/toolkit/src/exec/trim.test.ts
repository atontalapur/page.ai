import { describe, expect, it } from 'vitest';
import { combineOutput, trimOutput } from './trim.ts';

describe('trimOutput', () => {
  it('leaves output within the budget alone', () => {
    expect(trimOutput('abcdef', 6)).toBe('abcdef');
  });

  it('keeps the head and tail and says how much it dropped', () => {
    expect(trimOutput('0123456789', 4)).toBe('01\n[... 6 characters trimmed ...]\n89');
    expect(trimOutput('0123456789', 5)).toBe('012\n[... 5 characters trimmed ...]\n89');
  });

  it('keeps only the head when the budget is one character', () => {
    expect(trimOutput('0123', 1)).toBe('0\n[... 3 characters trimmed ...]\n');
  });

  it('defaults to an 8000 character budget', () => {
    const trimmed = trimOutput('x'.repeat(10_000));
    expect(trimmed).toContain('[... 2000 characters trimmed ...]');
  });
});

describe('combineOutput', () => {
  it.each([
    ['out', '', 'out'],
    ['', 'err', '[stderr]\nerr'],
    ['out', 'err', 'out\n[stderr]\nerr'],
    ['out\n', 'err', 'out\n[stderr]\nerr'],
    ['', '', ''],
  ])('combines %j and %j', (stdout, stderr, expected) => {
    expect(combineOutput(stdout, stderr)).toBe(expected);
  });
});
