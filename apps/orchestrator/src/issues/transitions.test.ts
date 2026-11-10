import type { IssueEvent, Tier } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import {
  isTerminal,
  IssueStateMachine,
  transition,
  TransitionError,
  type IssueState,
} from './transitions.ts';

const runId = '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60';
const fresh: IssueState = { status: 'new', class: null, severity: null, currentTier: null };
const fixing = (currentTier: Tier): IssueState => ({
  status: 'fixing',
  class: 'backend-api',
  severity: 'high',
  currentTier,
});

function run(state: IssueState, ...events: IssueEvent[]): IssueState {
  return events.reduce(transition, state);
}

describe('issue transitions', () => {
  it('runs the happy path from detection to resolution', () => {
    const triaged = transition(fresh, {
      type: 'triage',
      class: 'database',
      severity: 'critical',
    });
    expect(triaged).toEqual({
      status: 'triaged',
      class: 'database',
      severity: 'critical',
      currentTier: null,
    });
    expect(run(triaged, { type: 'start_fix' })).toMatchObject({ status: 'fixing', currentTier: 1 });
    expect(
      run(triaged, { type: 'start_fix' }, { type: 'patch_ready', runId }, { type: 'approve' }),
    ).toMatchObject({ status: 'resolved', currentTier: 1 });
  });

  it('escalates one tier at a time, then hands off to a human', () => {
    const escalate: IssueEvent = { type: 'escalate', runId, reason: 'tests still fail' };
    expect(transition(fixing(1), escalate)).toMatchObject({ status: 'fixing', currentTier: 2 });
    expect(transition(fixing(2), escalate)).toMatchObject({ status: 'fixing', currentTier: 3 });
    expect(transition(fixing(3), escalate)).toMatchObject({ status: 'failed', currentTier: 3 });
  });

  it('refuses to escalate an issue with no tier', () => {
    const state: IssueState = { ...fixing(1), currentTier: null };
    expect(() => transition(state, { type: 'escalate', runId, reason: 'x' })).toThrow(
      'issue is fixing but has no tier',
    );
  });

  it.each(['awaiting_approval', 'pr_open'] as const)(
    'resolves or escalates when a human decides on %s',
    (status) => {
      const waiting: IssueState = { ...fixing(2), status };
      expect(transition(waiting, { type: 'approve' })).toMatchObject({ status: 'resolved' });
      expect(transition(waiting, { type: 'reject', reason: 'wrong fix' })).toMatchObject({
        status: 'fixing',
        currentTier: 3,
      });
      expect(
        transition({ ...waiting, currentTier: 3 }, { type: 'reject', reason: 'wrong fix' }),
      ).toMatchObject({ status: 'failed' });
      expect(() => transition(waiting, { type: 'patch_ready', runId })).toThrow(TransitionError);
    },
  );

  it('kills from any open status', () => {
    for (const status of ['new', 'triaged', 'fixing', 'pr_open', 'awaiting_approval'] as const) {
      expect(transition({ ...fixing(1), status }, { type: 'kill' }).status).toBe('killed');
    }
  });

  it('rejects events that do not apply', () => {
    expect(() => transition(fresh, { type: 'start_fix' })).toThrow(TransitionError);
    expect(() => transition(fixing(1), { type: 'approve' })).toThrow(
      'cannot approve an issue that is fixing',
    );
    expect(() =>
      transition(fixing(1), { type: 'triage', class: 'frontend', severity: 'low' }),
    ).toThrow(TransitionError);
    for (const status of ['resolved', 'failed', 'killed'] as const) {
      expect(() => transition({ ...fixing(1), status }, { type: 'kill' })).toThrow(TransitionError);
      expect(() => transition({ ...fixing(1), status }, { type: 'approve' })).toThrow(
        TransitionError,
      );
    }
  });

  it('allows every legal transition and rejects a sample of illegal ones', () => {
    const machine = new IssueStateMachine();
    const triaged: IssueState = { ...fresh, status: 'triaged' };
    const legal: [IssueState, IssueEvent, IssueState['status']][] = [
      [fresh, { type: 'triage', class: 'frontend', severity: 'low' }, 'triaged'],
      [fresh, { type: 'kill' }, 'killed'],
      [triaged, { type: 'start_fix' }, 'fixing'],
      [triaged, { type: 'kill' }, 'killed'],
      [fixing(1), { type: 'patch_ready', runId }, 'awaiting_approval'],
      [fixing(1), { type: 'escalate', runId, reason: 'x' }, 'fixing'],
      [fixing(3), { type: 'escalate', runId, reason: 'x' }, 'failed'],
      [fixing(2), { type: 'kill' }, 'killed'],
      [{ ...fixing(2), status: 'awaiting_approval' }, { type: 'approve' }, 'resolved'],
      [{ ...fixing(2), status: 'awaiting_approval' }, { type: 'reject', reason: 'x' }, 'fixing'],
      [{ ...fixing(3), status: 'awaiting_approval' }, { type: 'reject', reason: 'x' }, 'failed'],
      [{ ...fixing(1), status: 'pr_open' }, { type: 'approve' }, 'resolved'],
      [{ ...fixing(1), status: 'pr_open' }, { type: 'reject', reason: 'x' }, 'fixing'],
      [{ ...fixing(3), status: 'pr_open' }, { type: 'reject', reason: 'x' }, 'failed'],
      [{ ...fixing(1), status: 'pr_open' }, { type: 'kill' }, 'killed'],
    ];
    for (const [state, event, status] of legal) {
      expect(machine.apply(state, event).status).toBe(status);
    }
    expect(machine.apply(fixing(1), { type: 'escalate', runId, reason: 'x' }).currentTier).toBe(2);

    const illegal: [IssueState, IssueEvent][] = [
      [fresh, { type: 'approve' }],
      [fresh, { type: 'start_fix' }],
      [triaged, { type: 'triage', class: 'frontend', severity: 'low' }],
      [fixing(1), { type: 'approve' }],
      [fixing(1), { type: 'reject', reason: 'x' }],
      [{ ...fixing(1), status: 'resolved' }, { type: 'kill' }],
      [{ ...fixing(1), status: 'failed' }, { type: 'start_fix' }],
      [
        { ...fixing(1), status: 'killed' },
        { type: 'escalate', runId, reason: 'x' },
      ],
      [
        { ...fixing(1), status: 'pr_open' },
        { type: 'patch_ready', runId },
      ],
    ];
    for (const [state, event] of illegal) {
      expect(() => machine.apply(state, event)).toThrow(TransitionError);
    }
  });

  it('knows which statuses are terminal', () => {
    expect(isTerminal('resolved')).toBe(true);
    expect(isTerminal('awaiting_approval')).toBe(false);
  });
});
