import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tier } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import { evalResultsSchema, loadResults, type Attempt } from './results.ts';
import { resultsFileName, runEval, type AttemptFn, type RunEvalOptions } from './runner.ts';
import type { Scenario } from './scenario.ts';

const scenario = (id: string, expectedTier: Tier = 1): Scenario => ({
  id,
  dir: `scenarios/${id}`,
  kind: expectedTier === 3 ? 'ops' : 'code',
  meta: { class: 'frontend', expectedTier, description: 'd', report: 'r' },
});

const attempt = (tier: Tier, over: Partial<Attempt> = {}): Attempt => ({
  tier,
  exitStatus: 'submitted',
  checkPassed: true,
  prOpened: false,
  modelCalls: 3,
  costUsd: 0.01,
  durationMs: 1000,
  steps: 4,
  blockedSteps: 0,
  diff: '',
  ...over,
});

/** Plays the outcomes in order, one per attempt, and records what was asked. */
function scripted(outcomes: Partial<Attempt>[]) {
  const calls: { id: string; tier: Tier; costLimitUsd: number }[] = [];
  const fn: AttemptFn = (s, tier, costLimitUsd) => {
    calls.push({ id: s.id, tier, costLimitUsd });
    return Promise.resolve(attempt(tier, outcomes[calls.length - 1] ?? {}));
  };
  return { fn, calls };
}

const clock = () => {
  let t = Date.parse('2026-11-08T10:00:00.000Z');
  return () => new Date((t += 1000));
};

const base = (attemptFn: AttemptFn, over: Partial<RunEvalOptions> = {}): RunEvalOptions => ({
  config: 'ladder',
  scenarios: [scenario('001-a')],
  runsPerScenario: 1,
  maxCostUsd: 1,
  attemptCostLimitUsd: 0.5,
  model: 'test/model',
  gitSha: 'abc123',
  attempt: attemptFn,
  now: clock(),
  ...over,
});

describe('runEval', () => {
  it('stops climbing at the first tier that submits', async () => {
    const { fn, calls } = scripted([{ exitStatus: 'step_limit', checkPassed: false }, {}]);
    const results = await runEval(base(fn));
    expect(calls.map((c) => c.tier)).toEqual([1, 2]);
    const [run] = results.runs;
    expect(run).toMatchObject({
      tierLanded: 2,
      fixed: true,
      paged: false,
      timeToFixMs: 2000,
      timeToPageMs: null,
      falseEscalations: 0,
    });
    expect(run!.costUsd).toBeCloseTo(0.02);
    expect(evalResultsSchema.parse(results)).toEqual(results);
  });

  it('pages when every tier gives up, and counts a passing patch it gave up on', async () => {
    const { fn } = scripted([
      { exitStatus: 'step_limit', checkPassed: true },
      { exitStatus: 'cost_limit', checkPassed: false },
      { exitStatus: 'time_limit', checkPassed: false },
    ]);
    const [run] = (await runEval(base(fn))).runs;
    expect(run).toMatchObject({
      tierLanded: null,
      fixed: false,
      paged: true,
      timeToFixMs: null,
      timeToPageMs: 3000,
      falseEscalations: 1,
      falsePage: false,
    });
  });

  it('counts a passing patch the last tier gave up on as a false page, not an escalation', async () => {
    const { fn } = scripted([{ exitStatus: 'step_limit', checkPassed: true }]);
    const results = await runEval(base(fn, { config: 'tier1-only' }));
    expect(results.runs[0]).toMatchObject({ paged: true, falseEscalations: 0, falsePage: true });
    expect(results.summary).toMatchObject({ falseEscalations: 0, falsePages: 1 });
  });

  it('counts a submitted patch that fails check.sh as not fixed', async () => {
    const { fn } = scripted([{ checkPassed: false }]);
    const results = await runEval(base(fn, { config: 'tier1-only' }));
    expect(results.runs[0]).toMatchObject({ tierLanded: 1, fixed: false, timeToFixMs: null });
    expect(results.summary).toMatchObject({ fixed: 0, fixRate: 0, costPerFixUsd: null });
  });

  it('starts at Tier 3 under tier3-start', async () => {
    const { fn, calls } = scripted([]);
    await runEval(base(fn, { config: 'tier3-start' }));
    expect(calls.map((c) => c.tier)).toEqual([3]);
  });

  it.each(['format_errors', 'model_error', 'audit_failed', 'aborted'] as const)(
    'pages without climbing when a tier ends with %s',
    async (exitStatus) => {
      const { fn, calls } = scripted([{ exitStatus, checkPassed: false }]);
      const [run] = (await runEval(base(fn))).runs;
      expect(calls.map((c) => c.tier)).toEqual([1]);
      expect(run).toMatchObject({ tierLanded: null, fixed: false, paged: true });
    },
  );

  it('plays every scenario N times, run by run', async () => {
    const { fn, calls } = scripted([]);
    const results = await runEval(
      base(fn, { scenarios: [scenario('001-a'), scenario('002-b')], runsPerScenario: 2 }),
    );
    expect(calls.map((c) => c.id)).toEqual(['001-a', '002-b', '001-a', '002-b']);
    expect(results.runs.map((r) => r.run)).toEqual([1, 1, 2, 2]);
    expect(results.summary).toMatchObject({ runs: 4, fixed: 4, fixRate: 1, steps: 16 });
    expect(results.summary.costPerFixUsd).toBeCloseTo(0.01);
  });

  it('skips ops scenarios with a reason', async () => {
    const { fn, calls } = scripted([]);
    const results = await runEval(base(fn, { scenarios: [scenario('024-ops', 3)] }));
    expect(calls).toEqual([]);
    expect(results.skipped.map((s) => s.scenario)).toEqual(['024-ops']);
    expect(results.skipped[0]!.reason).toMatch(/live demo app/);
    expect(results.summary).toMatchObject({ runs: 0, fixRate: 0, blockedPer100Steps: null });
  });

  it('lowers the last attempt to the budget left, then stops and drops the cut-short run', async () => {
    const { fn, calls } = scripted([
      { costUsd: 0.7 },
      { exitStatus: 'cost_limit', checkPassed: false, costUsd: 0.3 },
    ]);
    const results = await runEval(
      base(fn, { scenarios: [scenario('001-a'), scenario('002-b'), scenario('003-c')] }),
    );
    expect(calls.map((c) => [c.id, c.tier])).toEqual([
      ['001-a', 1],
      ['002-b', 1],
    ]);
    expect(calls[1]!.costLimitUsd).toBeCloseTo(0.3);
    expect(results.stoppedForBudget).toBe(true);
    expect(results.runs.map((r) => r.scenario)).toEqual(['001-a']);
  });

  it('drops a run whose last tier the budget cut short, not paging it', async () => {
    const { fn } = scripted([
      { costUsd: 0.7 },
      { exitStatus: 'cost_limit', checkPassed: false, costUsd: 0.3 },
    ]);
    const results = await runEval(
      base(fn, { config: 'tier1-only', scenarios: [scenario('001-a'), scenario('002-b')] }),
    );
    expect(results.stoppedForBudget).toBe(true);
    expect(results.runs.map((r) => r.scenario)).toEqual(['001-a']);
  });

  it('keeps a run that hit its own cost limit, with the full limit to spend', async () => {
    const { fn } = scripted([{ exitStatus: 'cost_limit', checkPassed: false, costUsd: 0.5 }]);
    const results = await runEval(base(fn, { config: 'tier1-only', maxCostUsd: 5 }));
    expect(results.stoppedForBudget).toBe(false);
    expect(results.runs[0]).toMatchObject({ paged: true });
  });

  it('starts no attempt with less than the minimum left', async () => {
    const { fn, calls } = scripted([{ costUsd: 0.96 }]);
    const results = await runEval(
      base(fn, { scenarios: [scenario('001-a'), scenario('002-b')], maxCostUsd: 1 }),
    );
    expect(calls.map((c) => c.id)).toEqual(['001-a']);
    expect(results.stoppedForBudget).toBe(true);
  });

  it('reports blocked steps per 100 steps', async () => {
    const { fn } = scripted([{ steps: 8, blockedSteps: 2 }]);
    const { summary } = await runEval(base(fn));
    expect(summary.blockedPer100Steps).toBe(25);
  });

  it('hands each finished run to onRun', async () => {
    const { fn } = scripted([]);
    const seen: string[] = [];
    await runEval(base(fn, { onRun: (r) => seen.push(r.scenario) }));
    expect(seen).toEqual(['001-a']);
  });
});

describe('results files', () => {
  it('names a results file by start time and config', () => {
    expect(resultsFileName({ startedAt: '2026-11-08T10:00:00.123Z', config: 'ladder' })).toBe(
      '2026-11-08T10-00-00Z-ladder.json',
    );
  });

  it('loads results it wrote, and rejects a malformed file', async () => {
    const { fn } = scripted([]);
    const results = await runEval(base(fn));
    const dir = await mkdtemp(join(tmpdir(), 'results-'));
    try {
      await writeFile(join(dir, 'ok.json'), JSON.stringify(results));
      await writeFile(join(dir, 'bad.json'), JSON.stringify({ ...results, v: 2 }));
      expect(await loadResults(join(dir, 'ok.json'))).toEqual(results);
      await expect(loadResults(join(dir, 'bad.json'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
