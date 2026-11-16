import { describe, expect, it } from 'vitest';
import { escapeXml } from './xml.ts';

describe('escapeXml', () => {
  it('escapes the five XML special characters, ampersands first', () => {
    expect(escapeXml(`a<b & "c" 'd'>`)).toBe('a&lt;b &amp; &quot;c&quot; &apos;d&apos;&gt;');
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves other text alone', () => {
    expect(escapeXml('Fix rate 0.94 (51/54)')).toBe('Fix rate 0.94 (51/54)');
  });
});
