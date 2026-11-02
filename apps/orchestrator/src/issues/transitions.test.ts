import type { IssueEvent, Tier } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import { isTerminal, transition, TransitionError, type IssueState } from './transitions.ts';

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
      run(triaged, { type: 'start_fix' }, { type: 'patch_ready' }, { type: 'approve' }),
    ).toMatchObject({ status: 'resolved', currentTier: 1 });
  });

  it('escalates one tier at a time, then hands off to a human', () => {
    const escalate: IssueEvent = { type: 'escalate', reason: 'tests still fail' };
    expect(transition(fixing(1), escalate)).toMatchObject({ status: 'fixing', currentTier: 2 });
    expect(transition(fixing(2), escalate)).toMatchObject({ status: 'fixing', currentTier: 3 });
    expect(transition(fixing(3), escalate)).toMatchObject({ status: 'failed', currentTier: 3 });
  });

  it('treats a missing tier as tier 1', () => {
    const state: IssueState = { ...fixing(1), currentTier: null };
    expect(transition(state, { type: 'escalate', reason: 'x' })).toMatchObject({ currentTier: 2 });
  });

  it('escalates when a human rejects the patch', () => {
    const awaiting: IssueState = { ...fixing(2), status: 'awaiting_approval' };
    expect(transition(awaiting, { type: 'reject', reason: 'wrong fix' })).toMatchObject({
      status: 'fixing',
      currentTier: 3,
    });
    expect(
      transition({ ...awaiting, currentTier: 3 }, { type: 'reject', reason: 'wrong fix' }),
    ).toMatchObject({ status: 'failed' });
  });

  it('kills from any open status', () => {
    for (const status of ['new', 'triaged', 'fixing', 'awaiting_approval'] as const) {
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
    }
  });

  it('knows which statuses are terminal', () => {
    expect(isTerminal('resolved')).toBe(true);
    expect(isTerminal('awaiting_approval')).toBe(false);
  });
});
