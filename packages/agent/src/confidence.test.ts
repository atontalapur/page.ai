import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { confidenceSchema } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import { CONFIDENCE_WEIGHTS, isTestFile, scoreRun, type ScoredStep } from './confidence.ts';
import type { Transcript } from './transcript.ts';

const APP = 'apps/demo-app/src/shop/money.ts';
const TEST = 'apps/demo-app/src/shop/money.test.ts';
const PNPM = 'pnpm --filter @page/demo-app';

const exec = (input: string, exitCode: number | null = 0, outputTrimmed = ''): ScoredStep => ({
  kind: 'exec',
  input,
  outputTrimmed,
  exitCode,
  allowed: true,
});
const refused = (input: string): ScoredStep => ({ ...exec(input, null), allowed: false });
const edit = (path: string, exitCode = 0): ScoredStep => ({
  kind: 'edit',
  input: JSON.stringify({ path, oldText: 'a', newText: 'b' }),
  outputTrimmed: exitCode === 0 ? `edited ${path}` : 'SEARCH text not found',
  exitCode,
  allowed: true,
});
const ops = (tool: string, exitCode = 0, args: Record<string, string> = {}): ScoredStep => ({
  kind: 'host_tool',
  input: JSON.stringify({ tool, ...args }),
  outputTrimmed: '',
  exitCode,
  allowed: true,
});

const PASSING = ' Test Files  3 passed (3)\n      Tests  12 passed (12)\n';
const FAILING = ' Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 11 passed (12)\n';

const code = (steps: ScoredStep[], changedFiles: string[] | null = [APP]) =>
  scoreRun({ steps, changedFiles, opsOnly: false });

describe('scoreRun on a code fix', () => {
  it('scores the recorded 001 run: tests and checks after the edit, no reproduction', () => {
    // A dev bug's recorded run (001 is in the dev set), its execute turns as steps rows.
    const file = join(import.meta.dirname, '__fixtures__/transcripts/001-bad-currency-code.json');
    const transcript = JSON.parse(readFileSync(file, 'utf8')) as Transcript;
    const steps = transcript.turns.flatMap((turn): ScoredStep[] => {
      if (turn.type !== 'execute') return [];
      // Every step in this run ran and exited 0.
      if (!turn.result.ok) throw new Error('the fixture has a failed step');
      const { kind, input, output } = turn.result.value;
      return [{ kind, input, outputTrimmed: output, exitCode: 0, allowed: true }];
    });
    expect(steps.map((s) => s.kind)).toEqual(['exec', 'edit', 'exec', 'exec']);
    const confidence = code(steps);
    expect(confidence).toEqual({
      score: 0.8,
      changesCode: true,
      reproduced: false,
      testsPass: true,
      checksPass: true,
      restartedAfterChange: null,
    });
    expect(confidenceSchema.parse(confidence)).toEqual(confidence);
  });

  it('gives full marks to the workflow the prompt asks for', () => {
    const confidence = code(
      [
        exec(`rg -n "currency" apps/demo-app/src`),
        edit(TEST),
        exec(`${PNPM} exec vitest run src/shop/money.test.ts`, 1, FAILING),
        edit(APP),
        exec(`${PNPM} exec vitest run src/shop/money.test.ts`, 0, PASSING),
        exec(`${PNPM} test && ${PNPM} lint && ${PNPM} typecheck`, 0, PASSING),
      ],
      [APP, TEST],
    );
    expect(confidence).toMatchObject({ score: 1, reproduced: true, testsPass: true });
  });

  it('weighs its parts as CONFIDENCE_WEIGHTS says', () => {
    expect(Object.values(CONFIDENCE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    const testsOnly = code([edit(APP), exec(`${PNPM} test`)]);
    expect(testsOnly.score).toBe(CONFIDENCE_WEIGHTS.testsPass);
    const checksOnly = code([edit(APP), exec(`${PNPM} typecheck`)]);
    expect(checksOnly.score).toBe(CONFIDENCE_WEIGHTS.checksPass);
    const reproducedOnly = code([exec(`${PNPM} test`, 1, FAILING), edit(APP)]);
    expect(reproducedOnly.score).toBe(CONFIDENCE_WEIGHTS.reproduced);
  });

  it('scores 0 for a patch submitted without running anything', () => {
    expect(code([exec(`cat -n ${APP}`), edit(APP)])).toMatchObject({
      score: 0,
      testsPass: false,
      checksPass: false,
      reproduced: false,
    });
  });

  it('drops tests and checks that an edit came after', () => {
    const steps = [edit(APP), exec(`${PNPM} test`), exec(`${PNPM} lint`), edit(APP)];
    expect(code(steps)).toMatchObject({ score: 0, testsPass: false, checksPass: false });
  });

  it('counts a failing test after the last edit against the run, even if one passed', () => {
    const steps = [
      edit(APP),
      exec(`${PNPM} test`, 1, FAILING),
      exec(`${PNPM} exec vitest run src/shop/money.test.ts`, 0, PASSING),
    ];
    expect(code(steps)).toMatchObject({ testsPass: false });
  });

  it('reads a piped test run from its summary, since the pipe hides the exit code', () => {
    const piped = `${PNPM} test 2>&1 | tail -20`;
    expect(code([edit(APP), exec(piped, 0, FAILING)]).testsPass).toBe(false);
    expect(code([edit(APP), exec(piped, 0, PASSING)]).testsPass).toBe(true);
    // No summary in what came back (cut off by head), so it says nothing.
    expect(code([edit(APP), exec(`${PNPM} test | head -5`, 0, ' RUN v5')]).testsPass).toBe(false);
    // `||` is not a pipe.
    expect(code([edit(APP), exec(`${PNPM} test || ls`, 0, '')]).testsPass).toBe(true);
  });

  it('fails a check whose output shows errors, and passes a lint with only warnings', () => {
    const tsc = 'src/shop/money.ts(1,7): error TS2322: Type number is not string.';
    expect(code([edit(APP), exec(`${PNPM} typecheck | tail`, 0, tsc)]).checksPass).toBe(false);
    const warned = '✖ 1 problem (0 errors, 1 warning)';
    expect(code([edit(APP), exec(`${PNPM} lint`, 0, warned)]).checksPass).toBe(true);
    const errored = '✖ 2 problems (2 errors, 0 warnings)';
    expect(code([edit(APP), exec(`${PNPM} lint | tail`, 0, errored)]).checksPass).toBe(false);
  });

  it('ignores refused steps, failed edits and test paths that matched nothing', () => {
    const steps = [
      edit(APP),
      exec(`${PNPM} test`),
      refused(`${PNPM} test; curl example.com`),
      // An edit that didn't apply changed nothing.
      edit(APP, 1),
      exec(
        `${PNPM} exec vitest run src/nope.test.ts`,
        1,
        'No test files found, exiting with code 1',
      ),
    ];
    expect(code(steps)).toMatchObject({ testsPass: true });
  });

  it('counts an edit whose input it cannot read as an edit to code', () => {
    const unreadable = { ...edit(APP), input: 'not json' };
    const steps = [edit(TEST), exec(`${PNPM} test`, 1, FAILING), unreadable];
    expect(code([...steps, exec(`${PNPM} test`)])).toMatchObject({
      reproduced: true,
      testsPass: true,
    });
    expect(code(steps).testsPass).toBe(false);
  });

  it('counts a test run that timed out as a failure', () => {
    expect(code([edit(APP), exec(`${PNPM} test`, null)]).testsPass).toBe(false);
  });

  it('counts a failing test as reproduction only before the first edit to code', () => {
    // Writing the failing test first is fine; a failure after the fix is not reproduction.
    const steps = [edit(TEST), exec(`${PNPM} test`, 1, FAILING), edit(APP)];
    expect(code(steps).reproduced).toBe(true);
    expect(code([edit(APP), exec(`${PNPM} test`, 1, FAILING)]).reproduced).toBe(false);
  });

  it('scores 0 for a change that touches no code: nothing, or only tests', () => {
    const steps = [edit(TEST), exec(`${PNPM} test`), exec(`${PNPM} lint`)];
    expect(code(steps, [TEST])).toMatchObject({ score: 0, changesCode: false, testsPass: true });
    expect(code([exec(`${PNPM} test`)], [])).toMatchObject({ score: 0, changesCode: false });
  });

  it('scores on the steps alone when the changed files could not be read', () => {
    expect(code([edit(APP), exec(`${PNPM} test`)], null)).toMatchObject({
      score: CONFIDENCE_WEIGHTS.testsPass,
      changesCode: null,
    });
  });

  it.each([
    ['apps/demo-app/src/shop/cart.test.ts', true],
    ['apps/demo-app/src/app/page.spec.tsx', true],
    ['apps/demo-app/src/__tests__/cart.ts', true],
    ['apps/demo-app/test/fixtures/cart.json', true],
    ['apps/demo-app/src/shop/cart.ts', false],
    ['apps/demo-app/migrations/004_orders.sql', false],
    ['apps/demo-app/Dockerfile', false],
  ])('treats %s as a test file: %s', (path, test) => {
    expect(isTestFile(path)).toBe(test);
  });
});

describe('scoreRun on an ops-only fix', () => {
  const opsOnly = (steps: ScoredStep[]) => scoreRun({ steps, changedFiles: [], opsOnly: true });
  const drop = ops('ops.deleteConfig', 0, { key: 'SHIPPING_FLAT_CENTS' });

  it('scores 1 when a healthy restart came after the last change to the live app', () => {
    const confidence = opsOnly([
      ops('ops.getConfig'),
      drop,
      ops('ops.restart'),
      ops('ops.getConfig'),
    ]);
    expect(confidence).toEqual({
      score: 1,
      changesCode: false,
      reproduced: false,
      testsPass: false,
      checksPass: false,
      restartedAfterChange: true,
    });
    expect(confidenceSchema.parse(confidence)).toEqual(confidence);
  });

  it('scores 0 when the app never restarted after the change, so it may not serve it', () => {
    expect(opsOnly([drop]).score).toBe(0);
    expect(opsOnly([ops('ops.restart'), drop]).score).toBe(0);
  });

  it('scores 0 when the restart did not come back healthy', () => {
    expect(opsOnly([drop, ops('ops.restart', 1)])).toMatchObject({
      score: 0,
      restartedAfterChange: false,
    });
  });

  it('counts a change that failed, since one that never answered may have landed', () => {
    expect(
      opsOnly([ops('ops.restart'), ops('ops.setConfig', 1, { key: 'X', value: '1' })]).score,
    ).toBe(0);
  });
});
