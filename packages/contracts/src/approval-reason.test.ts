import { describe, expect, it } from 'vitest';
import { approvalReason, MAX_APPROVAL_REASON_CHARS } from './approval-reason.ts';
import { pendingApprovalSchema } from './db.ts';

describe('approvalReason', () => {
  it('keeps the thought as it was written, newlines and tabs included', () => {
    const thought = 'The override is wrong.\n\n\tDropping it fixes the 500s.';
    expect(approvalReason(thought)).toBe(thought);
  });

  it('is null for no thought, and for one with nothing but space', () => {
    expect(approvalReason(undefined)).toBeNull();
    expect(approvalReason(null)).toBeNull();
    expect(approvalReason('')).toBeNull();
    expect(approvalReason(' \n\t ')).toBeNull();
    expect(approvalReason('\u0000\u202E')).toBeNull();
  });

  it('trims it, and turns Windows and old Mac line ends into newlines', () => {
    expect(approvalReason('  a\r\nb\rc  ')).toBe('a\nb\nc');
  });

  it('clips it to the cap, marking the cut', () => {
    const reason = approvalReason('x'.repeat(MAX_APPROVAL_REASON_CHARS + 50))!;
    expect(reason).toHaveLength(MAX_APPROVAL_REASON_CHARS);
    expect(reason.endsWith('...')).toBe(true);
    expect(approvalReason('x'.repeat(MAX_APPROVAL_REASON_CHARS))).toHaveLength(
      MAX_APPROVAL_REASON_CHARS,
    );
  });

  it('drops control characters and terminal escapes', () => {
    expect(approvalReason('safe\u0000 \u0007bell \u001b[31mred\u001b[0m \u007f\u0085end')).toBe(
      'safe bell [31mred[0m end',
    );
  });

  it('drops bidirectional marks, which could show the text in another order', () => {
    // Built from code points, so this file holds no hidden marks itself.
    const [rlo, pdf, lri, pdi, rlm, alm] = [0x202e, 0x202c, 0x2066, 0x2069, 0x200f, 0x061c].map(
      (point) => String.fromCodePoint(point),
    );
    // A right-to-left override would show "deppots ti" reversed, as "it stopped".
    const thought = `Restart ${rlo}deppots ti${pdf} now ${lri}x${pdi}${rlm}${alm}`;
    expect(approvalReason(thought)).toBe('Restart deppots ti now x');
  });

  it('leaves markup as the text it is', () => {
    const markup = '<script>alert(1)</script> [approve](javascript:alert(1)) **now**';
    expect(approvalReason(markup)).toBe(markup);
  });

  it('always fits the approval schema', () => {
    for (const thought of ['x'.repeat(5_000), ' y ', '<b>z</b>']) {
      const reason = approvalReason(thought);
      expect(pendingApprovalSchema.shape.reason.safeParse(reason).success).toBe(true);
    }
  });
});
