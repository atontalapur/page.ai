import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tier } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import { evalResultsSchema, loadResults, type Attempt } from './results.ts';
import {
  AttemptError,
  ProviderError,
  resultsFileName,
  runEval,
  type AgentAttempt,
  type AttemptFn,
  type RunEvalOptions,
} from './runner.ts';
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

/** The agent half of `a`, with a check that resolves its checkPassed. */
const played = ({ checkPassed, ...agent }: Attempt): AgentAttempt => ({
  agent,
  check: () => Promise.resolve(checkPassed),
});

/** Plays the outcomes in order, one per attempt, and records what was asked. */
function scripted(outcomes: Partial<Attempt>[]) {
  const calls: { id: string; tier: Tier; costLimitUsd: number }[] = [];
  const fn: AttemptFn = (s, tier, costLimitUsd) => {
    calls.push({ id: s.id, tier, costLimitUsd });
    return Promise.resolve(played(attempt(tier, outcomes[calls.length - 1] ?? {})));
  };
  return { fn, calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Attempts the test finishes by hand. `started` lists them in the order they started;
 * `settle(i, over)` ends the i-th one's agent with `over`.
 */
function manual() {
  const started: {
    id: string;
    tier: Tier;
    costLimitUsd: number;
    agent: ReturnType<typeof deferred<AgentAttempt>>;
  }[] = [];
  const fn: AttemptFn = (s, tier, costLimitUsd) => {
    const agent = deferred<AgentAttempt>();
    started.push({ id: s.id, tier, costLimitUsd, agent });
    return agent.promise;
  };
  const settle = (i: number, over: Partial<Attempt> = {}) => {
    const call = started[i]!;
    call.agent.resolve(played(attempt(call.tier, over)));
  };
  return { fn, started, settle };
}

/** Lets every pending promise callback run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

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
    // The cut-short run and the one never started are what to rerun.
    expect(results.notPlayed).toEqual([
      { scenario: '002-b', run: 1 },
      { scenario: '003-c', run: 1 },
    ]);
    // The dropped run's spend is in spentUsd, not in the summary of kept runs.
    expect(results.spentUsd).toBeCloseTo(1);
    expect(results.summary.costUsd).toBeCloseTo(0.7);
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

  it('records an attempt that throws, drops its run, and plays the rest', async () => {
    const calls: { id: string; costLimitUsd: number }[] = [];
    const fn: AttemptFn = (s, tier, costLimitUsd) => {
      calls.push({ id: s.id, costLimitUsd });
      if (s.id === '001-a') return Promise.reject(new Error('break.sh exited 1'));
      return Promise.resolve(played(attempt(tier)));
    };
    const results = await runEval(
      base(fn, { scenarios: [scenario('001-a'), scenario('002-b')], maxCostUsd: 0.8 }),
    );
    expect(results.errors).toEqual([
      { scenario: '001-a', run: 1, tier: 1, message: 'Error: break.sh exited 1' },
    ]);
    expect(results.runs.map((r) => r.scenario)).toEqual(['002-b']);
    // A crash without a stop is in errors only.
    expect(results.notPlayed).toEqual([]);
    // The crashed attempt's whole limit counts as spent.
    expect(calls[1]!.costLimitUsd).toBeCloseTo(0.3);
    expect(results.spentUsd).toBeCloseTo(0.51);
    expect(evalResultsSchema.parse(results)).toEqual(results);
  });

  it("charges an attempt that failed after the agent ran only the agent's cost", async () => {
    const calls: { id: string; costLimitUsd: number }[] = [];
    const fn: AttemptFn = (s, tier, costLimitUsd) => {
      calls.push({ id: s.id, costLimitUsd });
      if (s.id === '001-a') return Promise.reject(new AttemptError('diff unreadable', 0.02));
      return Promise.resolve(played(attempt(tier)));
    };
    const results = await runEval(
      base(fn, { scenarios: [scenario('001-a'), scenario('002-b')], maxCostUsd: 0.8 }),
    );
    expect(results.errors).toEqual([
      { scenario: '001-a', run: 1, tier: 1, message: 'AttemptError: diff unreadable' },
    ]);
    expect(calls[1]!.costLimitUsd).toBeCloseTo(0.5);
    expect(results.spentUsd).toBeCloseTo(0.03);
  });

  it('stops the eval at a provider error, dropping the run instead of paging it', async () => {
    const calls: string[] = [];
    const fn: AttemptFn = (s, tier) => {
      calls.push(s.id);
      if (s.id === '002-b') {
        return Promise.reject(new ProviderError('rate_limited', 'HTTP 429: quota', 0.01));
      }
      return Promise.resolve(played(attempt(tier)));
    };
    const results = await runEval(
      base(fn, { scenarios: [scenario('001-a'), scenario('002-b'), scenario('003-c')] }),
    );
    expect(calls).toEqual(['001-a', '002-b']);
    expect(results.runs.map((r) => r.scenario)).toEqual(['001-a']);
    expect(results.summary.falsePages).toBe(0);
    expect(results.stoppedForProvider).toBe(true);
    expect(results.stoppedForBudget).toBe(false);
    expect(results.notPlayed).toEqual([{ scenario: '003-c', run: 1 }]);
    expect(results.errors).toEqual([
      {
        scenario: '002-b',
        run: 1,
        tier: 1,
        message: 'ProviderError: model provider failed (rate_limited): HTTP 429: quota',
      },
    ]);
    expect(results.spentUsd).toBeCloseTo(0.02);
    expect(evalResultsSchema.parse(results)).toEqual(results);
  });

  it('stops runs in flight from climbing at a provider error, not as a budget stop', async () => {
    const { fn: other, started, settle } = manual();
    const fn: AttemptFn = (s, tier, limit) => {
      if (s.id === '002-b') {
        return Promise.reject(new ProviderError('rate_limited', 'HTTP 429', 0));
      }
      return other(s, tier, limit);
    };
    const running = runEval(
      base(fn, {
        scenarios: [scenario('001-a'), scenario('002-b'), scenario('003-c')],
        maxCostUsd: 5,
        concurrency: 2,
      }),
    );
    await flush();
    // 002-b failed at once; 003-c never starts, and 001-a doesn't climb past Tier 1.
    expect(started.map((c) => c.id)).toEqual(['001-a']);
    settle(0, { exitStatus: 'step_limit' });
    const results = await running;
    expect(started).toHaveLength(1);
    expect(results.stoppedForProvider).toBe(true);
    expect(results.stoppedForBudget).toBe(false);
    expect(results.runs).toEqual([]);
    expect(results.errors.map((e) => e.scenario)).toEqual(['002-b']);
    // 001-a was cut off mid-climb and 003-c never started. 001-a comes before 002-b in
    // the plan, so the list isn't just the tail.
    expect(results.notPlayed).toEqual([
      { scenario: '001-a', run: 1 },
      { scenario: '003-c', run: 1 },
    ]);
    expect(evalResultsSchema.parse(results)).toEqual(results);
  });

  it('reads a results file written before stoppedForProvider existed', async () => {
    const { fn } = scripted([]);
    const old: Record<string, unknown> = { ...(await runEval(base(fn))) };
    delete old.stoppedForProvider;
    expect(evalResultsSchema.parse(old).stoppedForProvider).toBe(false);
  });

  it('reads a results file written before notPlayed existed', async () => {
    const { fn } = scripted([]);
    const old: Record<string, unknown> = { ...(await runEval(base(fn))) };
    delete old.notPlayed;
    expect(evalResultsSchema.parse(old).notPlayed).toEqual([]);
  });

  it('starts no attempt with less than the minimum left', async () => {
    const { fn, calls } = scripted([{ costUsd: 0.96 }]);
    const results = await runEval(
      base(fn, { scenarios: [scenario('001-a'), scenario('002-b')], maxCostUsd: 1 }),
    );
    expect(calls.map((c) => c.id)).toEqual(['001-a']);
    expect(results.stoppedForBudget).toBe(true);
  });

  it("plays the next tier while the last tier's check runs", async () => {
    const events: string[] = [];
    const check = deferred<boolean>();
    const fn: AttemptFn = (_s, tier) => {
      events.push(`agent T${tier}`);
      const a = attempt(tier, tier === 1 ? { exitStatus: 'step_limit' } : {});
      return Promise.resolve({
        agent: played(a).agent,
        check: () => {
          events.push(`check T${tier}`);
          return tier === 1 ? check.promise : Promise.resolve(true);
        },
      });
    };
    const running = runEval(base(fn));
    await flush();
    expect(events).toEqual(['agent T1', 'check T1', 'agent T2', 'check T2']);
    check.resolve(false);
    const [run] = (await running).runs;
    expect(run!.attempts.map((a) => a.checkPassed)).toEqual([false, true]);
    expect(run).toMatchObject({ tierLanded: 2, fixed: true, falseEscalations: 0 });
  });

  it('records a check that fails, drops its run, and charges the agent its cost', async () => {
    const fn: AttemptFn = (s, tier) =>
      Promise.resolve({
        agent: played(attempt(tier, { costUsd: 0.02 })).agent,
        check:
          s.id === '001-a'
            ? () => Promise.reject(new Error('check sandbox failed'))
            : () => Promise.resolve(true),
      });
    const results = await runEval(
      base(fn, { scenarios: [scenario('001-a'), scenario('002-b')], maxCostUsd: 0.8 }),
    );
    expect(results.errors).toEqual([
      { scenario: '001-a', run: 1, tier: 1, message: 'Error: check sandbox failed' },
    ]);
    expect(results.runs.map((r) => r.scenario)).toEqual(['002-b']);
    expect(results.spentUsd).toBeCloseTo(0.04);
  });

  it('records a check that throws before it returns a promise', async () => {
    const fn: AttemptFn = (_s, tier) =>
      Promise.resolve({
        agent: played(attempt(tier)).agent,
        check: () => {
          throw new Error('no image');
        },
      });
    const results = await runEval(base(fn));
    expect(results.errors.map((e) => e.message)).toEqual(['Error: no image']);
    expect(results.runs).toEqual([]);
  });

  it('stops climbing once an earlier check has failed', async () => {
    const tiers: Tier[] = [];
    // The agent takes longer than the check takes to fail, as a real one does.
    const fn: AttemptFn = async (_s, tier) => {
      tiers.push(tier);
      await flush();
      return {
        agent: played(attempt(tier, { exitStatus: 'step_limit', costUsd: 0.02 })).agent,
        check: () => Promise.reject(new Error('check sandbox failed')),
      };
    };
    const results = await runEval(base(fn));
    // Tier 2 had started before Tier 1's check failed; Tier 3 never starts.
    expect(tiers).toEqual([1, 2]);
    expect(results.errors.map((e) => e.tier)).toEqual([1, 2]);
    expect(results.spentUsd).toBeCloseTo(0.04);
  });

  it('gives back the money a run got while its check failed', async () => {
    const check = deferred<boolean>();
    const { fn: other, started, settle } = manual();
    const fn: AttemptFn = (s, tier, limit) => {
      if (s.id === '002-b') return other(s, tier, limit);
      return Promise.resolve({
        agent: played(attempt(tier, { exitStatus: 'step_limit', costUsd: 0.1 })).agent,
        check: () => check.promise,
      });
    };
    const running = runEval(
      base(fn, {
        scenarios: [scenario('002-b'), scenario('001-a')],
        maxCostUsd: 1,
        concurrency: 2,
      }),
    );
    await flush();
    // 002-b holds $0.50; 001-a's Tier 1 spent $0.10, so its Tier 2 waits for money.
    check.reject(new Error('check sandbox failed'));
    await flush();
    settle(0);
    const results = await running;
    expect(started).toHaveLength(1);
    expect(results.errors).toEqual([
      { scenario: '001-a', run: 1, tier: 1, message: 'Error: check sandbox failed' },
    ]);
    expect(results.runs.map((r) => r.scenario)).toEqual(['002-b']);
    expect(results.spentUsd).toBeCloseTo(0.11);
    expect(results.stoppedForBudget).toBe(false);
  });

  it('records the checks and the crash of one run in tier order', async () => {
    const fn: AttemptFn = (_s, tier) => {
      if (tier === 2) return Promise.reject(new Error('break.sh exited 1'));
      return Promise.resolve({
        agent: played(attempt(tier, { exitStatus: 'step_limit' })).agent,
        check: () => Promise.reject(new Error('check sandbox failed')),
      });
    };
    const results = await runEval(base(fn));
    expect(results.errors.map((e) => [e.tier, e.message])).toEqual([
      [1, 'Error: check sandbox failed'],
      [2, 'Error: break.sh exited 1'],
    ]);
  });

  it('plays up to `concurrency` runs at once and keeps them in planned order', async () => {
    const { fn, started, settle } = manual();
    const seen: string[] = [];
    const running = runEval(
      base(fn, {
        config: 'tier1-only',
        scenarios: [scenario('001-a'), scenario('002-b'), scenario('003-c')],
        maxCostUsd: 5,
        concurrency: 2,
        onRun: (r) => seen.push(r.scenario),
      }),
    );
    await flush();
    expect(started.map((c) => c.id)).toEqual(['001-a', '002-b']);
    settle(1);
    await flush();
    // 002-b finished first, but onRun waits for 001-a.
    expect(started.map((c) => c.id)).toEqual(['001-a', '002-b', '003-c']);
    expect(seen).toEqual([]);
    settle(2);
    settle(0);
    const results = await running;
    expect(seen).toEqual(['001-a', '002-b', '003-c']);
    expect(results.runs.map((r) => r.scenario)).toEqual(['001-a', '002-b', '003-c']);
  });

  it('waits for an attempt in flight to give money back before starting another', async () => {
    const { fn, started, settle } = manual();
    const running = runEval(
      base(fn, {
        config: 'tier1-only',
        scenarios: [scenario('001-a'), scenario('002-b')],
        maxCostUsd: 0.8,
        concurrency: 2,
      }),
    );
    await flush();
    // 001-a holds $0.50 of $0.80: too little for a full limit while it might give back.
    expect(started.map((c) => c.id)).toEqual(['001-a']);
    settle(0, { costUsd: 0.1 });
    await flush();
    expect(started.map((c) => [c.id, c.costLimitUsd])).toEqual([
      ['001-a', 0.5],
      ['002-b', 0.5],
    ]);
    settle(1);
    const results = await running;
    expect(results.runs).toHaveLength(2);
    expect(results.spentUsd).toBeCloseTo(0.11);
  });

  it('lowers a limit only when no other attempt is in flight', async () => {
    const { fn, started, settle } = manual();
    const running = runEval(
      base(fn, {
        config: 'tier1-only',
        scenarios: [scenario('001-a'), scenario('002-b')],
        maxCostUsd: 0.7,
        concurrency: 2,
      }),
    );
    await flush();
    settle(0, { costUsd: 0.4 });
    await flush();
    expect(started[1]!.costLimitUsd).toBeCloseTo(0.3);
    settle(1, { costUsd: 0.05 });
    const results = await running;
    expect(results.stoppedForBudget).toBe(false);
    expect(results.runs).toHaveLength(2);
  });

  it('stops every run from climbing once the budget cuts one short', async () => {
    const { fn, started, settle } = manual();
    const running = runEval(
      base(fn, {
        scenarios: [scenario('001-a'), scenario('002-b'), scenario('003-c')],
        maxCostUsd: 1,
        concurrency: 2,
      }),
    );
    await flush();
    expect(started.map((c) => c.id)).toEqual(['001-a', '002-b']);
    // 001-a escalates and waits for money; 002-b spends it all.
    settle(0, { exitStatus: 'step_limit', costUsd: 0.45 });
    await flush();
    settle(1, { costUsd: 0.5 });
    await flush();
    // 001-a's Tier 2 got what was left, and the budget cut it short.
    expect(started.map((c) => [c.id, c.tier])).toEqual([
      ['001-a', 1],
      ['002-b', 1],
      ['001-a', 2],
    ]);
    expect(started[2]!.costLimitUsd).toBeCloseTo(0.05);
    settle(2, { exitStatus: 'cost_limit', costUsd: 0.05 });
    const results = await running;
    expect(started).toHaveLength(3);
    expect(results.stoppedForBudget).toBe(true);
    expect(results.runs.map((r) => r.scenario)).toEqual(['002-b']);
    expect(results.spentUsd).toBeCloseTo(1);
  });

  it('drops a run waiting to climb when another run stops the eval', async () => {
    const { fn, started, settle } = manual();
    const running = runEval(
      base(fn, {
        scenarios: [scenario('001-a'), scenario('002-b')],
        maxCostUsd: 0.6,
        concurrency: 2,
      }),
    );
    await flush();
    // Only 001-a fits a full limit; 002-b waits.
    expect(started.map((c) => c.id)).toEqual(['001-a']);
    settle(0, { exitStatus: 'step_limit', costUsd: 0.5 });
    await flush();
    // $0.10 left, nothing in flight: one of the two waiting runs gets it.
    expect(started).toHaveLength(2);
    settle(1, { exitStatus: 'cost_limit', costUsd: 0.1 });
    const results = await running;
    expect(started).toHaveLength(2);
    expect(results.stoppedForBudget).toBe(true);
    expect(results.runs).toEqual([]);
  });

  it('rejects a concurrency that is not a positive integer', async () => {
    const { fn } = scripted([]);
    await expect(runEval(base(fn, { concurrency: 0 }))).rejects.toThrow(RangeError);
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
