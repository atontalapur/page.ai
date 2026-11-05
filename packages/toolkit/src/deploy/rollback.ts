import { err, ok, type Result } from '../result.ts';
import type { Deployer, Deployment, DeploymentStatus } from './deployer.ts';

// How far back rollback() looks for the live deployment and a target.
export const ROLLBACK_WINDOW = 20;

// A deployment in one of these is what the service runs now, healthy or not.
const LIVE: ReadonlySet<string> = new Set<DeploymentStatus>(['SUCCESS', 'CRASHED', 'SLEEPING']);

export interface RollbackOptions {
  /** Plan only: pick the target and return it without deploying anything. */
  dryRun: boolean;
  /** A deployment id to go back to. Defaults to the one that was live before the current one. */
  to?: string;
}

export interface RollbackPlan {
  from: Deployment;
  to: Deployment;
}

export interface RollbackDone {
  dryRun: boolean;
  plan: RollbackPlan;
}

export type RollbackError =
  | { type: 'no_live_deployment'; message: string }
  | { type: 'no_target'; message: string }
  | { type: 'bad_target'; message: string }
  | { type: 'deployer_failed'; message: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Picks what to roll back from and to. `from` is the newest live deployment. With no `to`,
 * the target is the newest older deployment that served traffic (REMOVED) and can still
 * be redeployed; failed builds are skipped, since they never ran.
 */
export function planRollback(
  deployments: Deployment[],
  to?: string,
): Result<RollbackPlan, RollbackError> {
  const fromIndex = deployments.findIndex((d) => LIVE.has(d.status));
  const from = deployments[fromIndex];
  if (!from) {
    return err({ type: 'no_live_deployment', message: 'no live deployment to roll back from' });
  }

  if (to !== undefined) {
    const target = deployments.find((d) => d.id === to);
    if (!target) {
      return err({
        type: 'bad_target',
        message: `deployment ${to} is not among the last ${deployments.length}`,
      });
    }
    if (target.id === from.id) {
      return err({ type: 'bad_target', message: `deployment ${to} is already live` });
    }
    if (!target.canRollback) {
      return err({ type: 'bad_target', message: `deployment ${to} can no longer be redeployed` });
    }
    return ok({ from, to: target });
  }

  const target = deployments
    .slice(fromIndex + 1)
    .find((d) => d.status === 'REMOVED' && d.canRollback);
  if (!target) {
    return err({
      type: 'no_target',
      message: `no earlier deployment that served traffic and can be redeployed, in the last ${deployments.length}`,
    });
  }
  return ok({ from, to: target });
}

/**
 * Rolls the service back one good deployment, or to `options.to`. A dry run returns the
 * plan without deploying. A failure of the deployer itself comes back as
 * `deployer_failed`; on a real run that means the rollback may or may not have started.
 */
export async function rollback(
  deployer: Deployer,
  options: RollbackOptions,
): Promise<Result<RollbackDone, RollbackError>> {
  let deployments: Deployment[];
  try {
    deployments = await deployer.listDeployments(ROLLBACK_WINDOW);
  } catch (e) {
    return err({ type: 'deployer_failed', message: `listing deployments: ${message(e)}` });
  }

  const plan = planRollback(deployments, options.to);
  if (!plan.ok) return plan;
  if (options.dryRun) return ok({ dryRun: true, plan: plan.value });

  try {
    await deployer.rollbackTo(plan.value.to.id);
  } catch (e) {
    return err({
      type: 'deployer_failed',
      message: `rolling back to ${plan.value.to.id}: ${message(e)}`,
    });
  }
  return ok({ dryRun: false, plan: plan.value });
}
