import type { IssueEvent } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import { isTerminal, transition, TransitionError, type IssueState } from './transitions.ts';

const detected: IssueState = { status: 'detected', category: null, severity: null, tier: null };
const fixing = (tier: number): IssueState => ({
  status: 'fixing',
  category: 'backend',
  severity: 'high',
  tier,
});

function run(state: IssueState, ...events: IssueEvent[]): IssueState {
  return events.reduce(transition, state);
}

describe('issue transitions', () => {
  it('runs the happy path from detection to resolution', () => {
    const triaged = transition(detected, {
      type: 'triage',
      category: 'database',
      severity: 'critical',
    });
    expect(triaged).toEqual({
      status: 'triaged',
      category: 'database',
      severity: 'critical',
      tier: null,
    });
    expect(run(triaged, { type: 'start_fix' })).toMatchObject({ status: 'fixing', tier: 1 });
    expect(
      run(triaged, { type: 'start_fix' }, { type: 'patch_ready' }, { type: 'approve' }),
    ).toMatchObject({ status: 'resolved', tier: 1 });
  });

  it('escalates one tier at a time, then hands off to a human', () => {
    const escalate: IssueEvent = { type: 'escalate', reason: 'tests still fail' };
    expect(transition(fixing(1), escalate)).toMatchObject({ status: 'fixing', tier: 2 });
    expect(transition(fixing(2), escalate)).toMatchObject({ status: 'fixing', tier: 3 });
    expect(transition(fixing(3), escalate)).toMatchObject({ status: 'unresolved', tier: 3 });
  });

  it('treats a missing tier as tier 1', () => {
    const state: IssueState = { ...fixing(1), tier: null };
    expect(transition(state, { type: 'escalate', reason: 'x' })).toMatchObject({ tier: 2 });
  });

  it('escalates when a human rejects the patch', () => {
    const awaiting: IssueState = { ...fixing(2), status: 'awaiting_approval' };
    expect(transition(awaiting, { type: 'reject', reason: 'wrong fix' })).toMatchObject({
      status: 'fixing',
      tier: 3,
    });
    expect(
      transition({ ...awaiting, tier: 3 }, { type: 'reject', reason: 'wrong fix' }),
    ).toMatchObject({ status: 'unresolved' });
  });

  it('kills from any open status', () => {
    for (const status of ['detected', 'triaged', 'fixing', 'awaiting_approval'] as const) {
      expect(transition({ ...fixing(1), status }, { type: 'kill' }).status).toBe('killed');
    }
  });

  it('rejects events that do not apply', () => {
    expect(() => transition(detected, { type: 'start_fix' })).toThrow(TransitionError);
    expect(() => transition(fixing(1), { type: 'approve' })).toThrow(
      'cannot approve an issue that is fixing',
    );
    expect(() =>
      transition(fixing(1), { type: 'triage', category: 'frontend', severity: 'low' }),
    ).toThrow(TransitionError);
    for (const status of ['resolved', 'unresolved', 'killed'] as const) {
      expect(() => transition({ ...fixing(1), status }, { type: 'kill' })).toThrow(TransitionError);
    }
  });

  it('knows which statuses are terminal', () => {
    expect(isTerminal('resolved')).toBe(true);
    expect(isTerminal('awaiting_approval')).toBe(false);
  });
});
