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
 * it from here.
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
