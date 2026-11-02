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

// CSI sequences (colour, cursor movement, line clearing) and OSC sequences (hyperlinks,
// window titles) ended by BEL or ESC \. NO_COLOR covers most tools; this catches the rest.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Terminal escape codes cost budget and mean nothing to the agent. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
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
