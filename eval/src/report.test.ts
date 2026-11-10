import type { Tier } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import type { Attempt, EvalConfig, EvalResults, ScenarioRun } from './results.ts';
import { byConfig, checkBars, percentileSec, renderReport, ReportError } from './report.ts';

const attempt = (tier: Tier, over: Partial<Attempt> = {}): Attempt => ({
  tier,
  exitStatus: 'submitted',
  checkPassed: true,
  prOpened: false,
  modelCalls: 3,
  costUsd: 0.001,
  durationMs: 10_000,
  steps: 10,
  blockedSteps: 0,
  diff: '',
  ...over,
});

const run = (scenario: string, fixed: boolean, over: Partial<ScenarioRun> = {}): ScenarioRun => ({
  scenario,
  class: 'frontend',
  expectedTier: 1,
  run: 1,
  attempts: [attempt(1, { checkPassed: fixed, exitStatus: fixed ? 'submitted' : 'step_limit' })],
  tierLanded: fixed ? 1 : null,
  fixed,
  paged: !fixed,
  timeToFixMs: fixed ? 10_000 : null,
  timeToPageMs: fixed ? null : 20_000,
  falseEscalations: 0,
  falsePage: false,
  costUsd: 0.001,
  ...over,
});

const results = (
  config: EvalConfig,
  runs: ScenarioRun[],
  over: Partial<EvalResults> = {},
): EvalResults => {
  const fixed = runs.filter((r) => r.fixed).length;
  return {
    v: 1,
    config,
    model: 'm',
    gitSha: 'abcdef1234',
    startedAt: '2026-11-10T00:00:00.000Z',
    finishedAt: '2026-11-10T01:00:00.000Z',
    runsPerScenario: 1,
    maxCostUsd: 1,
    spentUsd: 0.01,
    stoppedForBudget: false,
    stoppedForProvider: false,
    runs,
    skipped: [],
    errors: [],
    notPlayed: [],
    summary: {
      runs: runs.length,
      fixed,
      fixRate: runs.length === 0 ? 0 : fixed / runs.length,
      costUsd: 0.01,
      costPerFixUsd: fixed === 0 ? null : 0.01 / fixed,
      falseEscalations: 0,
      falsePages: 0,
      steps: 10,
      blockedSteps: 0,
      blockedPer100Steps: 0,
    },
    ...over,
  };
};

describe('byConfig', () => {
  it('orders configs as the report does', () => {
    const out = byConfig([results('ladder', []), results('tier1-only', [])]);
    expect(out.map((f) => f.config)).toEqual(['tier1-only', 'ladder']);
  });

  it('refuses two files for one config', () => {
    expect(() => byConfig([results('ladder', []), results('ladder', [])])).toThrow(ReportError);
  });

  it('refuses files from different models', () => {
    expect(() =>
      byConfig([results('ladder', []), results('tier1-only', [], { model: 'x' })]),
    ).toThrow(/mix models/);
  });
});

describe('percentileSec', () => {
  it('uses nearest rank', () => {
    expect(percentileSec([3000, 1000, 2000, 4000], 50)).toBe(2);
    expect(percentileSec([3000, 1000, 2000, 4000], 90)).toBe(4);
    expect(percentileSec([], 50)).toBeNull();
  });
});

describe('checkBars', () => {
  it('passes the ladder bar at 0.8 x tier3-start and misses below it', () => {
    const tier3 = results('tier3-start', [
      run('a', true),
      run('b', true),
      run('c', true),
      run('d', true),
      run('e', true),
    ]);
    const pass = checkBars([
      tier3,
      results('ladder', [
        run('a', true),
        run('b', true),
        run('c', true),
        run('d', true),
        run('e', false),
      ]),
    ]);
    expect(pass[0]?.pass).toBe(true);
    const miss = checkBars([
      tier3,
      results('ladder', [
        run('a', true),
        run('b', true),
        run('c', true),
        run('d', false),
        run('e', false),
      ]),
    ]);
    expect(miss[0]?.pass).toBe(false);
  });

  it('scores tier1-only only on Tier 1 bugs', () => {
    const bars = checkBars([
      results('tier1-only', [
        run('a', true),
        run('b', false, { expectedTier: 3 }),
        run('c', false, { expectedTier: 2 }),
      ]),
    ]);
    expect(bars[1]).toMatchObject({ value: '1.00 (1/1)', pass: true });
    expect(bars[0]?.pass).toBeNull();
  });

  it('counts runs with a model_error attempt', () => {
    const bad = run('a', false, {
      attempts: [attempt(1, { exitStatus: 'model_error', checkPassed: false })],
    });
    expect(checkBars([results('tier1-only', [bad])])[2]).toMatchObject({ value: '1', pass: false });
  });
});

describe('renderReport', () => {
  it('lists bugs where the ladder fixed fewer runs than tier3-start', () => {
    const lost = run('009', false, {
      attempts: [
        attempt(1, { exitStatus: 'step_limit' }),
        attempt(2, { exitStatus: 'cost_limit' }),
        attempt(3, { exitStatus: 'time_limit' }),
      ],
    });
    const md = renderReport([
      results('tier3-start', [run('009', true, { tierLanded: 3 }), run('015', true)]),
      results('ladder', [lost, run('015', true)]),
    ]);
    expect(md).toContain('| 009 | 0 | 1 | T3 time_limit |');
    expect(md).not.toContain('| 015 |');
  });

  it('flags results the budget or provider cut short', () => {
    const md = renderReport([results('ladder', [run('a', true)], { stoppedForBudget: true })]);
    expect(md).toContain('Incomplete: ladder stopped for budget.');
  });

  it('refuses an empty set', () => {
    expect(() => renderReport([])).toThrow(ReportError);
  });
});
