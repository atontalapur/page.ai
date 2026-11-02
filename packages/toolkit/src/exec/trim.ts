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

/** stdout, then stderr under a label, as one block for the agent to read. */
export function combineOutput(stdout: string, stderr: string): string {
  if (stderr === '') return stdout;
  const label = '[stderr]\n';
  if (stdout === '') return `${label}${stderr}`;
  return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${label}${stderr}`;
}
