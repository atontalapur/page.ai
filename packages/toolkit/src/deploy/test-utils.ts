import type { Deployment } from './deployer.ts';

let n = 0;

/** A deployment with a unique id, created a minute after the previous one built here. */
export function deployment(overrides: Partial<Deployment> = {}): Deployment {
  n += 1;
  return {
    id: `dep-${n}`,
    status: 'REMOVED',
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
    commitSha: `sha${n}`,
    canRollback: true,
    ...overrides,
  };
}
