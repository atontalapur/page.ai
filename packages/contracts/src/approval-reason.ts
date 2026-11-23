import { clip } from './common.ts';

/** The most of the agent's reason that goes with an approval request. */
export const MAX_APPROVAL_REASON_CHARS = 1_000;

// Control characters, and the bidirectional marks that make text read in an order other than
// the one it is stored in. Newlines and tabs stay.
const HIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * The agent's reason for a gated call, as a person sees it with the request: the THOUGHT of
 * the step that asked, without control characters or bidirectional marks, which could hide or
 * reorder what the person reads, trimmed and clipped to MAX_APPROVAL_REASON_CHARS. Null when
 * nothing is left.
 *
 * It is the model's text, and the model read an error report anyone could have shaped, so it
 * is untrusted: it is stored and shown as plain text, and nothing parses or follows it.
 */
export function approvalReason(thought: string | null | undefined): string | null {
  const text = (thought ?? '').replace(/\r\n?/g, '\n').replace(HIDDEN, '').trim();
  return text === '' ? null : clip(text, MAX_APPROVAL_REASON_CHARS);
}
