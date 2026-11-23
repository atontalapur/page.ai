import type { Approval } from '@page/contracts';

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** A deployment as the daemon describes it: `{ id, status, commit, createdAt }`. */
function deployment(value: unknown, id: string): string {
  const d = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const commit = text(d.commit);
  const at = text(d.createdAt);
  const parts = [
    commit === undefined ? undefined : `commit ${commit.slice(0, 7)}`,
    at === undefined || Number.isNaN(Date.parse(at))
      ? undefined
      : `deployed ${new Date(at).toLocaleString()}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? id : `${id} (${parts.join(', ')})`;
}

/**
 * What a Tier 3 request would do to the live app, in plain words for the person deciding:
 * a short title and a sentence or two. A rollback names the deployment it replaces and the
 * one it deploys again. An action this build doesn't know shows its arguments as they came.
 */
export function describeApproval({ action, args }: Pick<Approval, 'action' | 'args'>): {
  title: string;
  detail: string;
} {
  const key = text(args.key) ?? 'a setting';
  switch (action) {
    case 'ops.setConfig':
      return {
        title: 'Change a setting on the live app',
        detail: `Set ${key} to "${text(args.value) ?? ''}". The app loads it on its next restart.`,
      };
    case 'ops.deleteConfig':
      return {
        title: 'Drop a setting override on the live app',
        detail: `Remove the override on ${key}, so the app's own value applies again on its next restart.`,
      };
    case 'ops.restart':
      return {
        title: 'Restart the live app',
        detail:
          'The app reloads its settings, including any change waiting for a restart. Requests in flight when it stops are dropped.',
      };
    case 'ops.rollback': {
      const to = text(args.to) ?? 'an earlier deployment';
      const from = text(args.from);
      return {
        title: 'Roll back the live app',
        detail:
          from === undefined
            ? `Deploy ${deployment(args.rollBackTo, to)} again in place of the live deployment.`
            : `Replace the live deployment ${deployment(args.live, from)} with the earlier deployment ${deployment(args.rollBackTo, to)}.`,
      };
    }
    default: {
      const rest = Object.fromEntries(Object.entries(args).filter(([name]) => name !== 'tool'));
      return { title: `Run ${action} on the live app`, detail: JSON.stringify(rest) };
    }
  }
}
