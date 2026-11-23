import type { IssueRun, Step } from '@page/contracts';

export type StepTone = 'ok' | 'bad' | 'refused' | 'running';

/**
 * How a step ended. A step is written before its command runs and completed after, so the
 * running run's last step with no exit code and no output yet is still going.
 */
export function stepResult(step: Step, running: boolean): { label: string; tone: StepTone } {
  if (!step.allowed) return { label: 'Refused', tone: 'refused' };
  if (step.exitCode === null && running && step.outputTrimmed === '') {
    return { label: 'Running', tone: 'running' };
  }
  if (step.exitCode === null) return { label: 'Timed out', tone: 'bad' };
  if (step.exitCode === 0) return { label: 'OK', tone: 'ok' };
  return { label: `Exit ${step.exitCode}`, tone: 'bad' };
}

/** Paths in the demo app read shorter without the workspace prefix. */
export const shortPath = (path: string) => path.replace(/^apps\/demo-app\//, '');

const CHECK = /\b(vitest|test|lint|typecheck|tsc)\b/;

/**
 * A command as a reader would name it: `Read products.ts`, `Run tests api.test.ts`. Null
 * for anything else, which is shown as written.
 */
export function commandLabel(command: string): { verb: string; target: string } | null {
  const vitest = /vitest run (\S+)/.exec(command);
  if (vitest) return { verb: 'Run tests', target: shortPath(vitest[1]!).replace(/^src\//, '') };
  if (/\btest$/.test(command)) return { verb: 'Run tests', target: 'full suite' };
  if (/\blint$/.test(command)) return { verb: 'Lint', target: 'demo app' };
  if (/\b(typecheck|tsc)$/.test(command)) return { verb: 'Typecheck', target: 'demo app' };
  const read = /^cat -n\s+"?([^"\s]+)"?$/.exec(command);
  if (read) return { verb: 'Read', target: shortPath(read[1]!) };
  return null;
}

/**
 * The lines of a step's output worth showing without opening it: the policy's reason for a
 * refusal, a test run's `Tests ...` tally, and the error a failing command printed.
 */
export function outputNotes(step: Step): { text: string; tone: 'muted' | StepTone }[] {
  if (!step.allowed) {
    return [{ text: step.outputTrimmed.replace(/^refused: /, 'Policy: '), tone: 'refused' }];
  }
  const out = step.outputTrimmed;
  const failed = step.exitCode !== null && step.exitCode !== 0;
  const notes: { text: string; tone: 'muted' | StepTone }[] = [];
  const tests = /Tests\s+\d+[^\n]*/.exec(out);
  if (tests && CHECK.test(step.input)) {
    notes.push({ text: tests[0].replace(/\s+/g, ' ').trim(), tone: failed ? 'bad' : 'muted' });
  }
  if (!failed) return notes;
  const error = /error: [^\n]+/.exec(out);
  if (error) notes.push({ text: error[0], tone: 'bad' });
  if (notes.length === 0) {
    const first = out
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('$'));
    if (first) notes.push({ text: first.slice(0, 160), tone: 'bad' });
  }
  return notes;
}

export type Phase = 'Explore' | 'Reproduce' | 'Diagnose' | 'Fix' | 'Verify';

export const PHASE_BLURBS: Record<Phase, string> = {
  Explore: 'Finding the code behind the error',
  Reproduce: 'Running the failing checks',
  Diagnose: 'Reading more to pin the cause down',
  Fix: 'Changing the code',
  Verify: 'Checking the change: tests, lint, typecheck',
};

/**
 * Groups a run's steps by what they were for, in order: reading before the first check
 * (Explore), checks before the first edit (Reproduce), reading between them (Diagnose), the
 * edits and anything between them (Fix), and whatever follows the last edit (Verify). A
 * phase that recurs, such as a second round of reading, is a new group.
 */
export function phasesOf(steps: readonly Step[]): { phase: Phase; steps: Step[] }[] {
  const firstEdit = steps.findIndex((s) => s.kind === 'edit');
  const lastEdit = steps.map((s) => s.kind).lastIndexOf('edit');
  const isCheck = (s: Step) => s.kind === 'exec' && s.allowed && CHECK.test(s.input);
  const beforeEdit = (i: number) => firstEdit === -1 || i < firstEdit;
  const firstCheck = steps.findIndex((s, i) => beforeEdit(i) && isCheck(s));

  const phaseOf = (s: Step, i: number): Phase => {
    if (s.kind === 'edit') return 'Fix';
    if (lastEdit !== -1 && i > lastEdit) return 'Verify';
    if (!beforeEdit(i)) return 'Fix';
    if (isCheck(s)) return 'Reproduce';
    return firstCheck !== -1 && i > firstCheck ? 'Diagnose' : 'Explore';
  };

  const groups: { phase: Phase; steps: Step[] }[] = [];
  steps.forEach((s, i) => {
    const phase = phaseOf(s, i);
    const last = groups.at(-1);
    if (last?.phase === phase) last.steps.push(s);
    else groups.push({ phase, steps: [s] });
  });
  return groups;
}

/** The figures a reviewer reads first about a run. */
export function runFigures(run: IssueRun) {
  const edits = run.steps.filter((s) => s.kind === 'edit');
  const files = new Set(
    edits.map((s) => {
      try {
        return (JSON.parse(s.input) as { path?: string }).path ?? '';
      } catch {
        return '';
      }
    }),
  );
  files.delete('');
  const durationMs =
    run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
  return {
    steps: run.steps.length,
    withThought: run.steps.filter((s) => s.thought).length,
    edits: edits.length,
    files: files.size,
    refused: run.steps.filter((s) => !s.allowed).length,
    durationMs,
  };
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** An edit step's input, or undefined when it doesn't parse as one. */
export function editOf(step: Step): { path: string; oldText: string; newText: string } | undefined {
  if (step.kind !== 'edit') return undefined;
  try {
    const e = JSON.parse(step.input) as { path?: unknown; oldText?: unknown; newText?: unknown };
    if (
      typeof e.path !== 'string' ||
      typeof e.oldText !== 'string' ||
      typeof e.newText !== 'string'
    ) {
      return undefined;
    }
    return { path: e.path, oldText: e.oldText, newText: e.newText };
  } catch {
    return undefined;
  }
}
