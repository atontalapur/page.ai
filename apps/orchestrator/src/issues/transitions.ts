import {
  MAX_TIER,
  TERMINAL_ISSUE_STATUSES,
  type Issue,
  type IssueEvent,
  type IssueStatus,
} from '@page/contracts';

/** The part of an issue that events change. */
export type IssueState = Pick<Issue, 'status' | 'class' | 'severity' | 'currentTier'>;

export class TransitionError extends Error {
  constructor(
    readonly status: IssueStatus,
    readonly event: IssueEvent['type'],
  ) {
    super(`cannot ${event} an issue that is ${status}`);
    this.name = 'TransitionError';
  }
}

export function isTerminal(status: IssueStatus): boolean {
  return (TERMINAL_ISSUE_STATUSES as readonly IssueStatus[]).includes(status);
}

/**
 * Moves a failed attempt up one tier, or hands the issue to a human once the top
 * tier has failed too.
 */
function escalate(state: IssueState): IssueState {
  const tier = state.currentTier ?? 1;
  if (tier === MAX_TIER) return { ...state, status: 'failed' };
  return { ...state, status: 'fixing', currentTier: tier === 1 ? 2 : 3 };
}

/** Returns the state after `event`, or throws TransitionError if `event` is not allowed. */
export function transition(state: IssueState, event: IssueEvent): IssueState {
  const { status } = state;
  if (event.type === 'kill' && !isTerminal(status)) return { ...state, status: 'killed' };

  switch (`${status}:${event.type}`) {
    case 'new:triage':
      if (event.type !== 'triage') break;
      return { ...state, status: 'triaged', class: event.class, severity: event.severity };
    case 'triaged:start_fix':
      return { ...state, status: 'fixing', currentTier: 1 };
    case 'fixing:patch_ready':
      return { ...state, status: 'awaiting_approval' };
    case 'fixing:escalate':
    case 'awaiting_approval:reject':
      return escalate(state);
    case 'awaiting_approval:approve':
      return { ...state, status: 'resolved' };
  }
  throw new TransitionError(status, event.type);
}
