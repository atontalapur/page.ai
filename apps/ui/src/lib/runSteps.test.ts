import type { IssueRun, Step } from '@page/contracts';
import { describe, expect, it } from 'vitest';

import {
  commandLabel,
  editOf,
  formatDuration,
  outputNotes,
  phasesOf,
  runFigures,
  stepResult,
} from './runSteps';

let seq = 0;
function step(input: string, fields: Partial<Step> = {}): Step {
  return {
    runId: '10000000-2222-4222-8222-222222222222',
    seq: seq++,
    kind: 'exec',
    input,
    outputTrimmed: '',
    exitCode: 0,
    allowed: true,
    thought: null,
    createdAt: '2026-11-23T07:54:00.000Z',
    ...fields,
  };
}
const edit = (path = 'apps/demo-app/src/shop/products.ts') =>
  step(JSON.stringify({ path, oldText: 'a', newText: 'b' }), { kind: 'edit' });

describe('stepResult', () => {
  it("names each outcome, and the running run's open last step as running", () => {
    expect(stepResult(step('ls'), false)).toEqual({ label: 'OK', tone: 'ok' });
    expect(stepResult(step('pnpm test', { exitCode: 1 }), false)).toEqual({
      label: 'Exit 1',
      tone: 'bad',
    });
    expect(stepResult(step('curl x', { allowed: false, exitCode: null }), true).label).toBe(
      'Refused',
    );
    const open = step('pnpm test', { exitCode: null });
    expect(stepResult(open, true).label).toBe('Running');
    expect(stepResult(open, false).label).toBe('Timed out');
    expect(stepResult({ ...open, outputTrimmed: 'killed' }, true).label).toBe('Timed out');
  });
});

describe('commandLabel', () => {
  it('names reads, test runs, lint and typecheck, and leaves anything else alone', () => {
    expect(commandLabel('cat -n "apps/demo-app/src/app/api/products/[slug]/route.ts"')).toEqual({
      verb: 'Read',
      target: 'src/app/api/products/[slug]/route.ts',
    });
    expect(
      commandLabel('pnpm --filter @page/demo-app exec vitest run src/shop/products.test.ts'),
    ).toEqual({ verb: 'Run tests', target: 'shop/products.test.ts' });
    expect(commandLabel('pnpm --filter @page/demo-app test')?.target).toBe('full suite');
    expect(commandLabel('pnpm --filter @page/demo-app lint')?.verb).toBe('Lint');
    expect(commandLabel('pnpm --filter @page/demo-app typecheck')?.verb).toBe('Typecheck');
    expect(commandLabel('rg -n "slug" apps/demo-app')).toBeNull();
  });
});

describe('outputNotes', () => {
  it("pulls a test run's tally and its error, and a refusal's reason", () => {
    const failing = step('pnpm --filter @page/demo-app test', {
      exitCode: 1,
      outputTrimmed:
        'x\nerror: operator does not exist: text = integer\n Tests  21 failed | 103 passed (124)\n',
    });
    expect(outputNotes(failing)).toEqual([
      { text: 'Tests 21 failed | 103 passed (124)', tone: 'bad' },
      { text: 'error: operator does not exist: text = integer', tone: 'bad' },
    ]);
    const passing = step('pnpm --filter @page/demo-app test', {
      outputTrimmed: ' Tests  2 passed (2)',
    });
    expect(outputNotes(passing)).toEqual([{ text: 'Tests 2 passed (2)', tone: 'muted' }]);
    const refused = step('cat x/[slug]', {
      allowed: false,
      exitCode: null,
      outputTrimmed: 'refused: unquoted glob characters are not allowed',
    });
    expect(outputNotes(refused)).toEqual([
      { text: 'Policy: unquoted glob characters are not allowed', tone: 'refused' },
    ]);
    const rejected = step('{"tool":"ops.restart"}', {
      kind: 'host_tool',
      allowed: false,
      exitCode: null,
      outputTrimmed: 'refused: ops.restart was not approved: Arjun rejected it',
    });
    expect(outputNotes(rejected)).toEqual([
      { text: 'ops.restart was not approved: Arjun rejected it', tone: 'refused' },
    ]);
  });

  it('falls back to the first line a failing command printed', () => {
    const s = step('rg -n x --type tsx', {
      exitCode: 2,
      outputTrimmed: '$ rg\nrg: unrecognized file type: tsx\n',
    });
    expect(outputNotes(s)).toEqual([{ text: 'rg: unrecognized file type: tsx', tone: 'bad' }]);
  });
});

describe('phasesOf', () => {
  it('reads the phases of a real fix: explore, reproduce, diagnose, fix, verify', () => {
    const steps = [
      step('cat -n src/a.ts'),
      step('pnpm --filter @page/demo-app exec vitest run src/a.test.ts', { exitCode: 1 }),
      step('cat -n src/schema.sql'),
      edit(),
      step('pnpm --filter @page/demo-app exec vitest run src/a.test.ts'),
      step('pnpm --filter @page/demo-app lint'),
    ];
    expect(phasesOf(steps).map((g) => [g.phase, g.steps.length])).toEqual([
      ['Explore', 1],
      ['Reproduce', 1],
      ['Diagnose', 1],
      ['Fix', 1],
      ['Verify', 2],
    ]);
  });

  it('keeps checks between two edits in Fix, and a run with no edits out of Verify', () => {
    const between = [edit(), step('pnpm --filter @page/demo-app test', { exitCode: 1 }), edit()];
    expect(phasesOf(between).map((g) => g.phase)).toEqual(['Fix']);
    const noEdit = [step('ls -la'), step('pnpm --filter @page/demo-app test', { exitCode: 1 })];
    expect(phasesOf(noEdit).map((g) => g.phase)).toEqual(['Explore', 'Reproduce']);
  });

  it('does not count a refused check as reproducing', () => {
    const steps = [step('pnpm test x/[a]', { allowed: false, exitCode: null }), step('ls')];
    expect(phasesOf(steps).map((g) => g.phase)).toEqual(['Explore']);
  });
});

describe('runFigures', () => {
  it('counts steps, thoughts, edits, files and refusals, and times the run', () => {
    const run = {
      startedAt: '2026-11-23T07:53:45.000Z',
      finishedAt: '2026-11-23T07:56:12.000Z',
      steps: [
        step('ls', { thought: 'Look around.' }),
        step('curl x', { allowed: false, exitCode: null }),
        edit(),
        edit(),
      ],
    } as IssueRun;
    expect(runFigures(run)).toEqual({
      steps: 4,
      withThought: 1,
      edits: 2,
      files: 1,
      refused: 1,
      durationMs: 147_000,
    });
    expect(formatDuration(147_000)).toBe('2m 27s');
    expect(formatDuration(9_400)).toBe('9s');
  });
});

describe('editOf', () => {
  it('reads an edit step and ignores anything else', () => {
    expect(editOf(edit('a.ts'))).toEqual({ path: 'a.ts', oldText: 'a', newText: 'b' });
    expect(editOf(step('ls'))).toBeUndefined();
    expect(editOf(step('{', { kind: 'edit' }))).toBeUndefined();
  });
});
