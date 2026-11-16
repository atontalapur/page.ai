import { describe, expect, it } from 'vitest';
import { maskNumber, maskNumbers } from './mask.ts';

describe('maskNumber', () => {
  it('keeps the last four digits only', () => {
    expect(maskNumber('+15551234567')).toBe('***4567');
    expect(maskNumber('(555) 123-4567')).toBe('***4567');
    expect(maskNumber('+12')).toBe('***');
  });
});

describe('maskNumbers', () => {
  it('masks numbers with or without a plus, and leaves error codes alone', () => {
    expect(maskNumbers('to +15551234567 from 5557654321, code 21608')).toBe(
      'to ***4567 from ***4321, code 21608',
    );
  });

  it('masks a number cut short by a truncated error', () => {
    expect(maskNumbers("Invalid 'To' Phone Number: +155512")).toBe(
      "Invalid 'To' Phone Number: ***5512",
    );
  });
});
