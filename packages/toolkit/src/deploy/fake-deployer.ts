import type { Deployer, Deployment } from './deployer.ts';

/**
 * A Deployer for tests. Holds deployments newest first and acts like Railway on a
 * rollback: the target's build goes live as a new deployment and the live one is
 * REMOVED. Set `failOn` to make the next list or rollback reject.
 */
export class FakeDeployer implements Deployer {
  readonly deployments: Deployment[];
  readonly rollbacks: string[] = [];
  failOn: 'list' | 'rollback' | null = null;
  private next = 0;

  constructor(deployments: Deployment[] = []) {
    this.deployments = [...deployments];
  }

  listDeployments(limit: number): Promise<Deployment[]> {
    if (this.failOn === 'list') return Promise.reject(new Error('deployer is down'));
    return Promise.resolve(this.deployments.slice(0, limit).map((d) => ({ ...d })));
  }

  rollbackTo(id: string): Promise<void> {
    if (this.failOn === 'rollback') return Promise.reject(new Error('deployer is down'));
    const target = this.deployments.find((d) => d.id === id);
    if (!target) return Promise.reject(new Error(`no deployment ${id}`));
    for (const d of this.deployments) {
      if (d.status === 'SUCCESS' || d.status === 'CRASHED' || d.status === 'SLEEPING') {
        d.status = 'REMOVED';
      }
    }
    this.rollbacks.push(id);
    this.deployments.unshift({
      id: `rollback-${this.next++}`,
      status: 'SUCCESS',
      createdAt: new Date().toISOString(),
      commitSha: target.commitSha,
      canRollback: true,
    });
    return Promise.resolve();
  }
}
