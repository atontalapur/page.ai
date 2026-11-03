import { describe, expect, it } from 'vitest';
import { combineOutput, stripAnsi, trimOutput } from './trim.ts';

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

describe('stripAnsi', () => {
  it('removes colour and style codes', () => {
    expect(stripAnsi('\x1b[2m Tests \x1b[22m \x1b[1m\x1b[32m1 passed\x1b[39m\x1b[22m')).toBe(
      ' Tests  1 passed',
    );
  });

  it('removes cursor movement and line clearing', () => {
    expect(stripAnsi('50%\x1b[2K\x1b[1G100%\x1b[?25h')).toBe('50%100%');
  });

  it('removes hyperlinks but keeps their text', () => {
    expect(stripAnsi('see \x1b]8;;https://x.dev\x07docs\x1b]8;;\x07 now')).toBe('see docs now');
    expect(stripAnsi('\x1b]8;;https://x.dev\x1b\\docs\x1b]8;;\x1b\\')).toBe('docs');
  });

  it('removes single-character escapes, 8-bit CSI and DCS', () => {
    expect(stripAnsi('a\x1b(Bb\x9b31mc\x1b7e')).toBe('abce');
    expect(stripAnsi('a\x1bP1$r0m\x1b\\b')).toBe('ab');
  });

  it('keeps the text after an OSC that lost its terminator', () => {
    const cut = 'x\x1b]0;title-no-term\n[... 5 characters dropped ...]\nmore text\x07end';
    expect(stripAnsi(cut)).toBe('x0;title-no-term\n[... 5 characters dropped ...]\nmore textend');
  });

  it('leaves plain text, tabs and newlines alone', () => {
    expect(stripAnsi('a\tb\n  c [x] ~')).toBe('a\tb\n  c [x] ~');
  });
});

describe('combineOutput without colour', () => {
  it('strips escape codes from both streams', () => {
    expect(combineOutput('\x1b[32mok\x1b[39m\n', '\x1b[31merr\x1b[39m')).toBe('ok\n[stderr]\nerr');
  });
});
