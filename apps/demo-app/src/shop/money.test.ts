import { describe, expect, it } from 'vitest';
import { formatCents } from './money.ts';

describe('formatCents', () => {
  it('formats US dollars', () => {
    expect(formatCents(2400)).toBe('$24.00');
    expect(formatCents(5)).toBe('$0.05');
  });
});
