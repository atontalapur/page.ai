// The port rollback() goes through. RailwayDeployer talks to Railway's API; FakeDeployer
// stands in for it in tests. The token lives with whoever builds the adapter (the
// orchestrator), never in the app being rolled back, so a broken app can still be
// rolled back.

/**
 * Railway's deployment statuses. A deployment that served traffic and was replaced by a
 * newer one ends REMOVED; one whose build or deploy failed ends FAILED and never served.
 */
export type DeploymentStatus =
  | 'BUILDING'
  | 'CRASHED'
  | 'DEPLOYING'
  | 'FAILED'
  | 'INITIALIZING'
  | 'NEEDS_APPROVAL'
  | 'QUEUED'
  | 'REMOVED'
  | 'REMOVING'
  | 'SKIPPED'
  | 'SLEEPING'
  | 'SUCCESS'
  | 'WAITING';

export interface Deployment {
  id: string;
  /** A status Railway adds later comes through as is, and counts as neither live nor removed. */
  status: DeploymentStatus | (string & {});
  /** ISO 8601. */
  createdAt: string;
  /** The commit it was built from, or null for a deploy not from git. */
  commitSha: string | null;
  /** Whether the platform still holds its image, so it can be deployed again. */
  canRollback: boolean;
}

export interface Deployer {
  /** The service's most recent deployments, newest first. */
  listDeployments(limit: number): Promise<Deployment[]>;
  /** Deploys `id`'s image and config again as a new deployment. Resolves once accepted. */
  rollbackTo(id: string): Promise<void>;
}
