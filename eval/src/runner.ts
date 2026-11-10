import type { Tier } from '@page/contracts';
import { runInOrder } from './pool.ts';
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

/** What an attempt's agent did, and how to run check.sh on its patch. */
export interface AgentAttempt {
  agent: Omit<Attempt, 'checkPassed'>;
  /**
   * Runs check.sh on the agent's diff in a sandbox of its own and resolves whether it
   * passed. The runner starts it as soon as the agent is done and plays the next tier
   * while it runs. A rejection drops the run and stops the tier playing after it; the
   * agent's cost is already charged. `signal` aborts once the run is dropped, and the
   * check should then stop its sandbox and reject with the signal's reason (an
   * AbortError), which isn't recorded as a failure.
   */
  check: (signal: AbortSignal) => Promise<boolean>;
}

/**
 * Plays one tier of one scenario: a fresh sandbox, break.sh, then the agent at `tier`
 * with at most `costLimitUsd` to spend. Resolves once the agent stops. `signal` aborts
 * once the run is dropped (an earlier tier's check failed) or a provider error stops the
 * eval; the attempt should then stop the agent and its sandbox. The runner drops the run
 * whatever an aborted attempt resolves, charging what it reports spent. The Docker-backed
 * one is in `scripts/attempt.ts`; tests pass a fake.
 */
export type AttemptFn = (
  scenario: Scenario,
  tier: Tier,
  costLimitUsd: number,
  signal: AbortSignal,
) => Promise<AgentAttempt>;

/**
 * An attempt that failed after the agent ran, such as a diff that couldn't be read.
 * It carries what the agent spent, so the budget is charged that and not the whole limit.
 */
export class AttemptError extends Error {
  override name = 'AttemptError';
  readonly costUsd: number;
  constructor(message: string, costUsd: number, options?: ErrorOptions) {
    super(message, options);
    this.costUsd = costUsd;
  }
}

/**
 * The agent ended on a model error that `withRetries` couldn't get past: a rate limit or
 * used-up quota, auth, credits, a provider outage or a malformed reply. It says nothing
 * about the agent, so the run is dropped rather than counted as a page, and the eval stops,
 * since the next attempt would hit the same wall.
 */
export class ProviderError extends AttemptError {
  override name = 'ProviderError';
  readonly kind: string;
  constructor(kind: string, message: string, costUsd: number, options?: ErrorOptions) {
    super(`model provider failed (${kind}): ${message}`, costUsd, options);
    this.kind = kind;
  }
}

/** The least budget an attempt starts with. Below it the run would only be cut short. */
export const MIN_ATTEMPT_USD = 0.05;

export interface RunEvalOptions {
  config: EvalConfig;
  scenarios: Scenario[];
  runsPerScenario: number;
  /**
   * Total spend across every attempt. Each attempt reserves its limit before it starts
   * and gives back what it didn't spend, so the limits of the attempts in flight never
   * add up to more than is left. No attempt starts with less than MIN_ATTEMPT_USD. The
   * agent checks its limit before each model call, so each attempt in flight can go over
   * by one call's cost.
   */
  maxCostUsd: number;
  /** The most one attempt may spend, before the remaining budget lowers it. */
  attemptCostLimitUsd: number;
  /**
   * Scenario runs played at once, each climbing its tiers in order (default 1). A run's
   * checks overlap its later tiers whatever this is. Each attempt in flight holds a full
   * attemptCostLimitUsd, so more than maxCostUsd / attemptCostLimitUsd runs never play
   * at once.
   */
  concurrency?: number;
  model: string;
  gitSha: string;
  attempt: AttemptFn;
  now?: () => Date;
  /** Each kept run, in the order the runs were planned. */
  onRun?: (run: ScenarioRun) => void;
  /**
   * An earlier results file for the same configuration, model and runs per scenario,
   * whose eval stopped before every run finished. Its runs are kept and not played again,
   * its spend counts against maxCostUsd, and its start time stays. Runs it lists in
   * `errors` or `notPlayed` are played.
   */
  resume?: EvalResults;
  /**
   * Stops the eval, as a pause: no attempt starts after it, attempts and checks in flight
   * stop, and their runs go in `notPlayed` to play on a resume.
   */
  signal?: AbortSignal;
  /** The results so far, after each planned run is kept or left out. */
  onCheckpoint?: (results: EvalResults) => void;
}

/**
 * Hands out attempt limits so that concurrent attempts can't spend more between them
 * than the budget allows.
 */
class Budget {
  spent = 0;
  /**
   * Set once the eval has stopped, for the budget or a provider failure. No attempt
   * starts after that.
   */
  stopped = false;
  private reserved = 0;
  private inFlight = 0;
  private waiting: (() => void)[] = [];
  private readonly maxUsd: number;
  private readonly attemptUsd: number;

  constructor(maxUsd: number, attemptUsd: number) {
    this.maxUsd = maxUsd;
    this.attemptUsd = attemptUsd;
  }

  /**
   * Reserves the next attempt's limit. That is the full per-attempt limit while the
   * budget has it. Less than that goes out only when no other attempt is in flight to
   * give money back, so an attempt isn't cut short by money another attempt won't spend.
   * Resolves undefined when the budget can't pay for a real attempt, or has stopped.
   */
  async reserve(): Promise<number | undefined> {
    for (;;) {
      if (this.stopped) return undefined;
      const free = this.maxUsd - this.spent - this.reserved;
      let limit: number | undefined;
      if (free >= this.attemptUsd) limit = this.attemptUsd;
      else if (this.inFlight === 0) {
        // Too little left for a real attempt: it would only be cut short.
        if (free < MIN_ATTEMPT_USD) return undefined;
        limit = free;
      }
      if (limit !== undefined) {
        this.reserved += limit;
        this.inFlight++;
        return limit;
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  /** Charges what an attempt spent against its reservation and frees the rest. */
  settle(limit: number, costUsd: number): void {
    this.reserved -= limit;
    this.spent += costUsd;
    this.inFlight--;
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }
}

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

/** How one planned run ended. */
interface RunOutcome {
  /** Set when the run counts; left out when it crashed or the eval stopped it. */
  result?: ScenarioRun;
  errors: EvalResults['errors'];
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
 * after every attempt, so a patch that already fixed the bug still counts: as a false
 * escalation when a higher tier took over, or a false page when the run paged.
 * Up to `concurrency` runs play at once; results come back in the planned order.
 */
export async function runEval(options: RunEvalOptions): Promise<EvalResults> {
  const now = options.now ?? (() => new Date());
  const startedAt = options.resume?.startedAt ?? now().toISOString();
  const tiers = EVAL_CONFIGS[options.config];
  const runs: ScenarioRun[] = [...(options.resume?.runs ?? [])];
  const kept = new Set(runs.map((r) => `${r.scenario}#${r.run}`));
  const skipped: EvalResults['skipped'] = [];
  const errors: EvalResults['errors'] = [];
  const notPlayed: EvalResults['notPlayed'] = [];
  const budget = new Budget(options.maxCostUsd, options.attemptCostLimitUsd);
  budget.spent = options.resume?.spentUsd ?? 0;
  let stoppedForBudget = false;
  let stoppedForProvider = false;

  const playable = options.scenarios.filter((scenario) => {
    const reason = skipReason(scenario);
    if (reason !== undefined) skipped.push({ scenario: scenario.id, reason });
    return reason === undefined;
  });

  const planned: { scenario: Scenario; run: number }[] = [];
  for (let run = 1; run <= options.runsPerScenario; run++) {
    for (const scenario of playable) {
      if (!kept.has(`${scenario.id}#${run}`)) planned.push({ scenario, run });
    }
  }

  // Aborted when a provider error or the caller stops the eval: every attempt and check in
  // flight ends.
  const stopAll = new AbortController();
  const stopForProvider = () => {
    stoppedForProvider = true;
    budget.stop();
    stopAll.abort();
  };
  const pause = () => {
    budget.stop();
    stopAll.abort();
  };
  if (options.signal?.aborted) pause();
  else options.signal?.addEventListener('abort', pause, { once: true });

  const play = async (scenario: Scenario, run: number): Promise<RunOutcome> => {
    const played: { agent: Omit<Attempt, 'checkPassed'>; check: Promise<boolean> }[] = [];
    let crash: EvalResults['errors'][number] | undefined;
    // Aborted once the run is dropped: its attempt and checks in flight stop early.
    const dropped = new AbortController();
    const signal = AbortSignal.any([dropped.signal, stopAll.signal]);
    // A run cut short by the budget, at any tier, says nothing about the agent, so it is
    // left out, and no attempt starts after it, in this run or any other. A run that
    // another run's stop cuts off is left out too.
    let cutShort = false;
    for (const tier of tiers) {
      if (signal.aborted) break;
      const limit = await budget.reserve();
      if (limit === undefined) {
        cutShort = true;
        if (!budget.stopped) {
          stoppedForBudget = true;
          budget.stop();
        }
        break;
      }
      // A check may have failed while this run waited for money.
      if (signal.aborted) {
        budget.settle(limit, 0);
        break;
      }
      let attempt: AgentAttempt;
      try {
        attempt = await options.attempt(scenario, tier, limit, signal);
      } catch (error) {
        // Unless the attempt says what the agent spent, its whole limit counts as spent.
        budget.settle(limit, error instanceof AttemptError ? error.costUsd : limit);
        if (error instanceof ProviderError) stopForProvider();
        else if (signal.aborted) {
          // Stopped because the run was dropped; that cause is already recorded.
          cutShort = true;
          break;
        }
        // A sandbox or script failure says nothing about the agent. Record it, drop the
        // run and go on, so the runs already paid for still reach the results file.
        crash = { scenario: scenario.id, run, tier, message: String(error) };
        break;
      }
      budget.settle(limit, attempt.agent.costUsd);
      if (signal.aborted) {
        cutShort = true;
        break;
      }
      // Out of money because the budget lowered the limit, not the agent's own limit.
      if (attempt.agent.exitStatus === 'cost_limit' && limit < options.attemptCostLimitUsd) {
        cutShort = true;
        stoppedForBudget = true;
        budget.stop();
        break;
      }
      // The check runs alongside the next tier: whether to climb depends only on how
      // the agent stopped. A check that fails drops the run and stops that tier.
      const check = new Promise<boolean>((resolve) => resolve(attempt.check(signal)));
      check.catch((error: unknown) => {
        if (!isAbort(error)) dropped.abort();
      });
      played.push({ agent: attempt.agent, check });
      if (!escalates(attempt.agent.exitStatus)) break;
    }
    // Nothing a dropped run's checks find is used, so they stop early.
    if (cutShort || crash !== undefined) dropped.abort();
    // Every check started is waited for, so no sandbox outlives the eval.
    const checks = await Promise.allSettled(played.map((p) => p.check));
    const errors: EvalResults['errors'] = [];
    checks.forEach((check, i) => {
      // A check stopped because the run was dropped found nothing.
      if (check.status === 'rejected' && !isAbort(check.reason)) {
        const { tier } = played[i]!.agent;
        errors.push({ scenario: scenario.id, run, tier, message: String(check.reason) });
      }
    });
    if (crash !== undefined) errors.push(crash);
    // A run with no errors is left out only when a stop cut it off (notPlayed).
    if (cutShort || errors.length > 0 || checks.some((c) => c.status === 'rejected')) {
      return { errors };
    }
    const attempts = played.map((p, i) => {
      const check = checks[i]!;
      return { ...p.agent, checkPassed: check.status === 'fulfilled' && check.value };
    });
    return { result: scenarioRun(scenario, run, attempts), errors };
  };

  // Kept runs in the planned order (run by run, scenario by scenario), resumed ones included.
  const position = new Map(playable.map((s, i) => [s.id, i]));
  const order = (r: ScenarioRun) => (r.run - 1) * playable.length + (position.get(r.scenario) ?? 0);
  const results = (): EvalResults => ({
    v: 1,
    config: options.config,
    model: options.model,
    gitSha: options.gitSha,
    startedAt,
    finishedAt: now().toISOString(),
    runsPerScenario: options.runsPerScenario,
    maxCostUsd: options.maxCostUsd,
    spentUsd: budget.spent,
    stoppedForBudget,
    stoppedForProvider,
    runs: [...runs].sort((a, b) => order(a) - order(b)),
    skipped: [...skipped],
    errors: [...errors],
    notPlayed: [...notPlayed],
    summary: summarize(runs),
  });

  await runInOrder(
    planned,
    options.concurrency ?? 1,
    // A run planned after the eval stopped isn't played.
    ({ scenario, run }) =>
      budget.stopped ? Promise.resolve<RunOutcome>({ errors: [] }) : play(scenario, run),
    (outcome, { scenario, run }) => {
      errors.push(...outcome.errors);
      if (outcome.result === undefined) {
        // Only a stop leaves a run out with nothing in `errors`.
        if (outcome.errors.length === 0) notPlayed.push({ scenario: scenario.id, run });
        return;
      }
      runs.push(outcome.result);
      options.onRun?.(outcome.result);
    },
    () => options.onCheckpoint?.(results()),
  );
  options.signal?.removeEventListener('abort', pause);
  return results();
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
    // Only a tier that handed the run on escalated. The last one, when it gave up, paged.
    falseEscalations: attempts.slice(0, -1).filter((a) => a.checkPassed).length,
    falsePage: final === undefined && (attempts.at(-1)?.checkPassed ?? false),
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
    falsePages: runs.filter((r) => r.falsePage).length,
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
