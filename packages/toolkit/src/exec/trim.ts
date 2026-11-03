import { stripVTControlCharacters } from 'node:util';

/** Characters of command output the agent sees per step. */
export const DEFAULT_OUTPUT_BUDGET = 8_000;

/**
 * Cuts text down to about `budget` characters, keeping the head and the tail: the start of
 * a test run says what ran and the end says what failed. A marker in the middle says how
 * much was dropped, and is not counted against the budget.
 */
export function trimOutput(text: string, budget = DEFAULT_OUTPUT_BUDGET): string {
  if (text.length <= budget) return text;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  const dropped = text.length - budget;
  return `${text.slice(0, head)}\n[... ${dropped} characters trimmed ...]\n${tail > 0 ? text.slice(-tail) : ''}`;
}

// String sequences (OSC hyperlinks and window titles, DCS, SOS, PM, APC) end with BEL or
// ST. The body may not cross a newline: Capture can cut off a terminator, and an unbounded
// body would then eat everything up to the next BEL, including Capture's own marker.
// eslint-disable-next-line no-control-regex
const STRING_SEQUENCE = /(?:\x1b[P\]X^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)/g;
// Introducers left without a terminator, and BELs left without an introducer. Dropping them
// keeps stripVTControlCharacters from reading on past the newline.
// eslint-disable-next-line no-control-regex
const STRAY = /\x1b[P\]X^_]|[\x90\x98\x9d-\x9f]|\x07/g;

/**
 * Terminal escape codes cost budget and mean nothing to the agent. NO_COLOR covers most
 * tools; this catches the rest.
 */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text.replace(STRING_SEQUENCE, '').replace(STRAY, ''));
}

/** stdout, then stderr under a label, as one block for the agent to read, without escapes. */
export function combineOutput(rawStdout: string, rawStderr: string): string {
  const stdout = stripAnsi(rawStdout);
  const stderr = stripAnsi(rawStderr);
  if (stderr === '') return stdout;
  const label = '[stderr]\n';
  if (stdout === '') return `${label}${stderr}`;
  return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${label}${stderr}`;
}
