import type { Confidence } from '@page/contracts';
import type { StepEntry } from '@page/toolkit';

/** The parts of an audit step the score reads. */
export type ScoredStep = Pick<
  StepEntry,
  'kind' | 'input' | 'outputTrimmed' | 'exitCode' | 'allowed'
>;

/** What the daemon knows about a run once its agent submits. */
export interface SubmittedRun {
  /** Every execute() call the run made, refusals included, in the order they ran. */
  steps: readonly ScoredStep[];
  /**
   * The paths `git status` shows changed in the workspace, new files included. Null when
   * they couldn't be read, which leaves `changesCode` unknown rather than counting it against
   * the run.
   */
  changedFiles: readonly string[] | null;
  /** The fix is the run's changes to the live app alone (`opsOnly` on the result). */
  opsOnly: boolean;
}

/** What each part adds to a code fix's score. They sum to 1. */
export const CONFIDENCE_WEIGHTS = { testsPass: 0.5, checksPass: 0.3, reproduced: 0.2 } as const;

// Tests, fixtures and snapshots: changing only these leaves the app as it was.
const TEST_FILE =
  /(^|\/)(__tests__|__mocks__|__fixtures__|__snapshots__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export const isTestFile = (path: string): boolean => TEST_FILE.test(path);

type Kind = 'test' | 'check';

const TOOLS: Record<Kind, ReadonlySet<string>> = {
  test: new Set(['test', 'vitest', 'jest']),
  check: new Set(['typecheck', 'tsc', 'lint', 'eslint']),
};

// pnpm options that take a value, so the word after one is not the script.
const PNPM_VALUE_OPTIONS = new Set(['--filter', '-F', '--dir', '-C', '--reporter']);
// pnpm commands that run the word after them.
const PNPM_RUNNERS = new Set(['run', 'exec', 'dlx']);

/** The tool one command runs: `pnpm --filter @page/demo-app test` runs `test`. */
function toolOf(words: readonly string[]): string | undefined {
  if (words[0] !== 'pnpm') return words[0];
  let i = 1;
  while (words[i]?.startsWith('-')) i += PNPM_VALUE_OPTIONS.has(words[i]!) ? 2 : 1;
  const word = words[i];
  return word !== undefined && PNPM_RUNNERS.has(word) ? words[i + 1] : word;
}

/** Whether a command line runs a test (or a typecheck or lint) anywhere in it. */
function runs(kind: Kind, command: string): boolean {
  return command
    .split(/&&|\|\||[;|]/)
    .map((part) => toolOf(part.trim().split(/\s+/)))
    .some((tool) => tool !== undefined && TOOLS[kind].has(tool));
}

// Vitest's summary lines, and tsc's and eslint's errors. Any of them is a failure whatever the
// exit code says.
const FAILED =
  /^\s*(Test Files|Tests)\s+.*\b[1-9]\d* failed\b|^\s*Errors\s+[1-9]\d* errors?\b|\berror TS\d+\b|\(([1-9]\d*) errors?,/m;
const PASSED = /^\s*Tests\s+[1-9]\d* passed\b/m;
const NO_TESTS = /No test files found/;
// One `|` that isn't half of `||`.
const PIPE = /(^|[^|])\|([^|]|$)/;

type Outcome = 'pass' | 'fail' | 'unknown';

/** How a test or check step ended. Only steps that ran (allowed ones) get here. */
function outcomeOf(step: ScoredStep, kind: Kind): Outcome {
  // Timed out, or the runner broke.
  if (step.exitCode === null) return 'fail';
  const output = step.outputTrimmed;
  // A path that matched no test file says nothing about the code.
  if (kind === 'test' && NO_TESTS.test(output)) return 'unknown';
  if (step.exitCode !== 0 || FAILED.test(output)) return 'fail';
  // `sh -c` has no pipefail, so a pipe exits with its last command: `pnpm test | tail` exits 0
  // when tests fail. Then only Vitest's summary can say it passed.
  if (!PIPE.test(step.input)) return 'pass';
  return kind === 'test' && PASSED.test(output) ? 'pass' : 'unknown';
}

const parsed = (input: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(input);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** The file an edit step changed, or undefined for any other step and an edit that failed. */
function editedPath(step: ScoredStep): string | undefined {
  if (step.kind !== 'edit' || !step.allowed || step.exitCode !== 0) return undefined;
  const { path } = parsed(step.input);
  // An edit whose path can't be read still changed a file, and counts as code.
  return typeof path === 'string' ? path : '';
}

// The ops tools that change the live app.
const CHANGES: ReadonlySet<string> = new Set(['ops.setConfig', 'ops.deleteConfig', 'ops.rollback']);

/** The ops tool a host tool step called, or undefined for any other step. */
function opsTool(step: ScoredStep): string | undefined {
  if (step.kind !== 'host_tool' || !step.allowed) return undefined;
  const { tool } = parsed(step.input);
  return typeof tool === 'string' && tool.startsWith('ops.') ? tool : undefined;
}

function lastIndex<T>(items: readonly T[], test: (item: T, index: number) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!, i)) return i;
  return -1;
}

const round = (score: number) => Math.round(score * 100) / 100;

/**
 * Scores how sure a submitted run is of its fix, from what the daemon can measure: the run's
 * steps and the files it changed. It asks no model. The report and the diff are the agent's
 * and the error's words, so nothing here reads them as instructions.
 *
 * A code fix earns `CONFIDENCE_WEIGHTS` for each part that holds: tests passed after the last
 * edit, a typecheck or lint passed after it, and a test failed before the first edit to code
 * (the agent saw the bug). A change that touches no code (nothing, or tests only) scores 0,
 * since it can't change what the app runs. An ops-only fix changed no code, so it scores on
 * the live app instead: 1 when, after its last change, a restart came back healthy or a
 * rollback's deployment went live, else 0.
 */
export function scoreRun({ steps, changedFiles, opsOnly }: SubmittedRun): Confidence {
  const edits = steps.map(editedPath);
  const lastEdit = lastIndex(edits, (path) => path !== undefined);
  const firstCodeEdit = edits.findIndex((path) => path !== undefined && !isTestFile(path));
  const beforeCode = firstCodeEdit === -1 ? steps.length : firstCodeEdit;

  const outcomes = (kind: Kind) =>
    steps.flatMap((step, i) =>
      step.allowed && step.kind === 'exec' && runs(kind, step.input)
        ? [{ i, outcome: outcomeOf(step, kind) }]
        : [],
    );
  const passedAfterLastEdit = (kind: Kind) => {
    const after = outcomes(kind).filter((r) => r.i > lastEdit && r.outcome !== 'unknown');
    return after.length > 0 && after.every((r) => r.outcome === 'pass');
  };

  const parts = {
    changesCode: changedFiles === null ? null : changedFiles.some((path) => !isTestFile(path)),
    reproduced: outcomes('test').some((r) => r.i < beforeCode && r.outcome === 'fail'),
    testsPass: passedAfterLastEdit('test'),
    checksPass: passedAfterLastEdit('check'),
  };

  if (opsOnly) {
    const tools = steps.map(opsTool);
    // What puts the app's current state live: a restart, ok only once the app answers its
    // health check again, or a rollback, ok only once its new deployment is live. A new
    // deployment reads the settings at boot, as a restart does.
    const live = (step: ScoredStep, i: number) =>
      (tools[i] === 'ops.restart' || tools[i] === 'ops.rollback') && step.exitCode === 0;
    // Any change the run sent counts, since one that never answered may still have landed.
    // A rollback that went live is its own change and its own going live.
    const lastChange = lastIndex(
      steps,
      (step, i) => CHANGES.has(tools[i] ?? '') && !(tools[i] === 'ops.rollback' && live(step, i)),
    );
    const liveAfterChange = lastIndex(steps, live) > lastChange;
    return { score: liveAfterChange ? 1 : 0, ...parts, liveAfterChange };
  }

  const score =
    parts.changesCode === false
      ? 0
      : round(
          CONFIDENCE_WEIGHTS.testsPass * Number(parts.testsPass) +
            CONFIDENCE_WEIGHTS.checksPass * Number(parts.checksPass) +
            CONFIDENCE_WEIGHTS.reproduced * Number(parts.reproduced),
        );
  return { score, ...parts, liveAfterChange: null };
}
