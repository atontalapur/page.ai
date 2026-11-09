import type { Tier } from '@page/contracts';
import {
  EVAL_CONFIGS,
  type Attempt,
  type EvalConfig,
  type EvalResults,
  type EvalSummary,
  type ScenarioRun,
} from './results.ts';
import type { Scenario } from './scenario.ts';

/**
 * Whether the daemon would hand this run to the next tier. Only running out of budget
 * escalates (apps/node/src/run/outcome.ts); a model, format or audit failure fails the
 * issue and pages a human, since a higher tier won't fix those.
 */
export function escalates(exitStatus: Attempt['exitStatus']): boolean {
  return exitStatus === 'step_limit' || exitStatus === 'cost_limit' || exitStatus === 'time_limit';
}

/**
 * Plays one tier of one scenario: a fresh sandbox, break.sh, the agent at `tier` with at
 * most `costLimitUsd` to spend, then check.sh. The Docker-backed one is in
 * `scripts/attempt.ts`; tests pass a fake.
 */
export type AttemptFn = (scenario: Scenario, tier: Tier, costLimitUsd: number) => Promise<Attempt>;

/** The least budget an attempt starts with. Below it the run would only be cut short. */
export const MIN_ATTEMPT_USD = 0.05;

export interface RunEvalOptions {
  config: EvalConfig;
  scenarios: Scenario[];
  runsPerScenario: number;
  /**
   * Total spend across every attempt. No attempt starts with less than MIN_ATTEMPT_USD
   * left. The agent checks its limit before each model call, so the total can go over by
   * one call's cost.
   */
  maxCostUsd: number;
  /** The most one attempt may spend, before the remaining budget lowers it. */
  attemptCostLimitUsd: number;
  model: string;
  gitSha: string;
  attempt: AttemptFn;
  now?: () => Date;
  onRun?: (run: ScenarioRun) => void;
}

/** What scenarios a run can't play, and why. Ops bugs live in a running app. */
export function skipReason(scenario: Scenario): string | undefined {
  if (scenario.kind === 'ops') return 'ops scenario: needs a live demo app (Tier 3 ops tools)';
  return undefined;
}

/**
 * Plays every scenario `runsPerScenario` times under one configuration and collects the
 * results. Each run climbs the configuration's tiers while the agent runs out of budget,
 * and stops at a submit or any other exit, as the daemon does; check.sh runs
 * after every attempt, so an escalated patch that already fixed the bug still counts, as
 * a false escalation.
 */
export async function runEval(options: RunEvalOptions): Promise<EvalResults> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const tiers = EVAL_CONFIGS[options.config];
  const runs: ScenarioRun[] = [];
  const skipped: EvalResults['skipped'] = [];
  let spent = 0;
  let stoppedForBudget = false;

  const playable = options.scenarios.filter((scenario) => {
    const reason = skipReason(scenario);
    if (reason !== undefined) skipped.push({ scenario: scenario.id, reason });
    return reason === undefined;
  });

  outer: for (let run = 1; run <= options.runsPerScenario; run++) {
    for (const scenario of playable) {
      const attempts: Attempt[] = [];
      for (const tier of tiers) {
        const remaining = options.maxCostUsd - spent;
        // Too little left for a real attempt: it would only be cut short.
        if (remaining < MIN_ATTEMPT_USD) {
          stoppedForBudget = true;
          break;
        }
        const limit = Math.min(options.attemptCostLimitUsd, remaining);
        const attempt = await options.attempt(scenario, tier, limit);
        spent += attempt.costUsd;
        attempts.push(attempt);
        // Out of money because the budget lowered the limit, not the agent's own limit.
        if (attempt.exitStatus === 'cost_limit' && limit < options.attemptCostLimitUsd) {
          stoppedForBudget = true;
          break;
        }
        if (!escalates(attempt.exitStatus)) break;
      }
      // A run cut short by the budget, at any tier, says nothing about the agent, so it is
      // left out, and nothing after it runs.
      if (stoppedForBudget) break outer;
      const result = scenarioRun(scenario, run, attempts);
      runs.push(result);
      options.onRun?.(result);
    }
  }

  return {
    v: 1,
    config: options.config,
    model: options.model,
    gitSha: options.gitSha,
    startedAt,
    finishedAt: now().toISOString(),
    runsPerScenario: options.runsPerScenario,
    maxCostUsd: options.maxCostUsd,
    stoppedForBudget,
    runs,
    skipped,
    summary: summarize(runs),
  };
}

export function scenarioRun(scenario: Scenario, run: number, attempts: Attempt[]): ScenarioRun {
  const landed = attempts.findIndex((a) => a.exitStatus === 'submitted');
  const final = landed === -1 ? undefined : attempts[landed];
  const elapsed = (upTo: number) =>
    attempts.slice(0, upTo + 1).reduce((ms, a) => ms + a.durationMs, 0);
  const fixed = final?.checkPassed ?? false;
  return {
    scenario: scenario.id,
    class: scenario.meta.class,
    expectedTier: scenario.meta.expectedTier,
    run,
    attempts,
    tierLanded: final?.tier ?? null,
    fixed,
    paged: final === undefined,
    timeToFixMs: fixed ? elapsed(landed) : null,
    timeToPageMs: final === undefined ? elapsed(attempts.length - 1) : null,
    falseEscalations: attempts.filter((a) => a.exitStatus !== 'submitted' && a.checkPassed).length,
    costUsd: attempts.reduce((usd, a) => usd + a.costUsd, 0),
  };
}

export function summarize(runs: ScenarioRun[]): EvalSummary {
  const attempts = runs.flatMap((r) => r.attempts);
  const fixed = runs.filter((r) => r.fixed).length;
  const costUsd = runs.reduce((usd, r) => usd + r.costUsd, 0);
  const steps = attempts.reduce((n, a) => n + a.steps, 0);
  const blockedSteps = attempts.reduce((n, a) => n + a.blockedSteps, 0);
  return {
    runs: runs.length,
    fixed,
    fixRate: runs.length === 0 ? 0 : fixed / runs.length,
    costUsd,
    costPerFixUsd: fixed === 0 ? null : costUsd / fixed,
    falseEscalations: runs.reduce((n, r) => n + r.falseEscalations, 0),
    steps,
    blockedSteps,
    blockedPer100Steps: steps === 0 ? null : (blockedSteps / steps) * 100,
  };
}

/** `eval/results/2026-11-08T10-00-00Z-ladder.json`: sortable, and safe on every filesystem. */
export function resultsFileName(results: Pick<EvalResults, 'startedAt' | 'config'>): string {
  const stamp = results.startedAt.replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
  return `${stamp}-${results.config}.json`;
}
