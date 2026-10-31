import { describe, expect, it } from 'vitest';
import { parseId } from './ids.ts';

describe('parseId', () => {
  it('accepts positive int4 ids', () => {
    expect(parseId('1')).toBe(1);
    expect(parseId('2147483647')).toBe(2147483647);
  });

  it('rejects anything Postgres would choke on', () => {
    for (const bad of ['', 'abc', '0', '-1', '1.5', '1e3', ' 1', '2147483648', '9999999999']) {
      expect(parseId(bad), bad).toBeUndefined();
    }
    expect(parseId(null)).toBeUndefined();
    expect(parseId(new File([], 'x'))).toBeUndefined();
  });
});
