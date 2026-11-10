import {
  MAX_TIER,
  TERMINAL_ISSUE_STATUSES,
  type Issue,
  type IssueEvent,
  type IssueStatus,
  type Tier,
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
  const tier = state.currentTier;
  if (tier === null) throw new Error(`issue is ${state.status} but has no tier`);
  if (tier === MAX_TIER) return { ...state, status: 'failed' };
  return { ...state, status: 'fixing', currentTier: (tier + 1) as Tier };
}

/** Returns the next state, or undefined when the event does not apply. */
type Rule = (state: IssueState, event: IssueEvent) => IssueState | undefined;

/** A patch, or the PR opened for it, waiting on a human. */
const awaitingHuman: Rule = (state, event) => {
  switch (event.type) {
    case 'approve':
      return { ...state, status: 'resolved' };
    case 'reject':
      return escalate(state);
    default:
      return undefined;
  }
};

const none: Rule = () => undefined;

// Keyed by every status, so adding one to ISSUE_STATUSES fails to compile until it has rules.
const rules: Record<IssueStatus, Rule> = {
  new: (state, event) =>
    event.type === 'triage'
      ? { ...state, status: 'triaged', class: event.class, severity: event.severity }
      : undefined,
  triaged: (state, event) =>
    event.type === 'start_fix' ? { ...state, status: 'fixing', currentTier: 1 } : undefined,
  fixing: (state, event) => {
    switch (event.type) {
      case 'patch_ready':
        return { ...state, status: 'awaiting_approval' };
      case 'escalate':
        return escalate(state);
      default:
        return undefined;
    }
  },
  pr_open: awaitingHuman,
  awaiting_approval: awaitingHuman,
  resolved: none,
  failed: none,
  killed: none,
};

/** Applies one event. IssuesService routes every status change through this. */
export class IssueStateMachine {
  apply(state: IssueState, event: IssueEvent): IssueState {
    return transition(state, event);
  }
}

/** Returns the state after `event`, or throws TransitionError if `event` is not allowed. */
export function transition(state: IssueState, event: IssueEvent): IssueState {
  const { status } = state;
  if (event.type === 'kill' && !isTerminal(status)) return { ...state, status: 'killed' };
  const next = rules[status](state, event);
  if (!next) throw new TransitionError(status, event.type);
  return next;
}
