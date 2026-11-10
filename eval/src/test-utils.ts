// Synthetic eval results for tests, built through the results schema's types.
import type { Tier } from '@page/contracts';
import type { Attempt, EvalConfig, EvalResults, ScenarioRun } from './results.ts';

export const attempt = (tier: Tier, over: Partial<Attempt> = {}): Attempt => ({
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

export const run = (
  scenario: string,
  fixed: boolean,
  over: Partial<ScenarioRun> = {},
): ScenarioRun => ({
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

export const results = (
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
