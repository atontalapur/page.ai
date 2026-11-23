import type { ExecContext } from '@page/toolkit';

type Tier = ExecContext['tier'];

/** What an agent may spend at one tier before it stops. */
export interface TierBudget {
  /** Model calls. */
  stepLimit: number;
  costLimitUsd: number;
  wallTimeLimitMs: number;
}

/**
 * The escalation threshold (#114): the budget an agent gets at each tier. A run that
 * reaches any of these limits before it submits escalates to the next tier; at Tier 3 it
 * fails and pages a human (apps/node/src/run/outcome.ts). The daemon and the eval both read
 * it from here. A run that submits can still escalate on CONFIDENCE_THRESHOLD below.
 *
 * Tuned on dev bugs only. Once #114 records the freeze, changing a value invalidates the
 * held-out results (docs/report/eval-prereg.md).
 */
export const ESCALATION_THRESHOLD: Readonly<Record<Tier, Readonly<TierBudget>>> = {
  // The sandbox kills the container at 15 minutes, so each tier stops a little before.
  1: { stepLimit: 40, costLimitUsd: 0.5, wallTimeLimitMs: 14 * 60 * 1000 },
  2: { stepLimit: 40, costLimitUsd: 0.5, wallTimeLimitMs: 14 * 60 * 1000 },
  3: { stepLimit: 40, costLimitUsd: 0.5, wallTimeLimitMs: 14 * 60 * 1000 },
};

/** The budget for `tier`, as AgentConfig fields. */
export function budgetFor(tier: Tier): TierBudget {
  return { ...ESCALATION_THRESHOLD[tier] };
}

/**
 * The confidence a submitted run needs at each tier (scoreRun in confidence.ts). A run that
 * submits with a lower score escalates to the next tier as `low_confidence`; at Tier 3 it
 * fails and pages a human, as a run out of budget does. A run with no score never escalates
 * on it. The daemon and the eval both read it from here.
 *
 * Not tuned yet: every eval run reported in docs/report came before it. At 0.3 a code fix
 * escalates only when no test, typecheck or lint passed after its last edit, or when its
 * change touches no code (nothing, or tests only). An ops-only fix escalates when nothing put
 * its last change to the live app live: no healthy restart and no rollback that went live
 * after it. Tune it on dev bugs only; the held-out set has had its one run.
 */
export const CONFIDENCE_THRESHOLD: Readonly<Record<Tier, number>> = {
  1: 0.3,
  2: 0.3,
  3: 0.3,
};

/** Whether a submitted run scored below its tier's confidence threshold. No score never is. */
export function isLowConfidence(confidence: { score: number } | null, tier: Tier): boolean {
  return confidence !== null && confidence.score < CONFIDENCE_THRESHOLD[tier];
}
