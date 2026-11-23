import { describe, expect, it } from 'vitest';
import { approverNameSchema, deciderFor, SYSTEM_DECIDERS } from './db.ts';
import {
  ISSUE_EVENT_ACTORS,
  issueEventRecordSchema,
  issueEventSchema,
  newIssueSchema,
} from './issue.ts';
import { roundTrip } from './test-utils.ts';

describe('issue event actors', () => {
  const record = {
    id: '1',
    issueId: '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60',
    event: { type: 'kill' },
    fromStatus: 'fixing',
    toStatus: 'killed',
    currentTier: 1,
    createdAt: '2026-11-23T12:00:00.000Z',
  };

  it('takes a person, a sender that is not one, or none for an old row', () => {
    for (const actor of [deciderFor('Arjun'), ...Object.values(ISSUE_EVENT_ACTORS), null]) {
      expect(roundTrip(issueEventRecordSchema, { ...record, actor }).actor).toBe(actor);
    }
    expect(issueEventRecordSchema.safeParse(record).success).toBe(false);
  });

  it('keeps every sender that is not a person apart from a person and from the deciders', () => {
    for (const actor of Object.values(ISSUE_EVENT_ACTORS)) {
      expect(approverNameSchema.safeParse(actor).success).toBe(false);
      expect(Object.values(SYSTEM_DECIDERS)).not.toContain(actor);
    }
  });
});

describe('issue contracts', () => {
  it('trims and bounds a new issue', () => {
    expect(newIssueSchema.parse({ fingerprint: ' fp ', title: ' Boom ' })).toEqual({
      fingerprint: 'fp',
      title: 'Boom',
    });
    expect(newIssueSchema.safeParse({ fingerprint: '', title: 'Boom' }).success).toBe(false);
    expect(newIssueSchema.safeParse({ fingerprint: '  ', title: 'Boom' }).success).toBe(false);
  });

  it('accepts known events and rejects unknown ones', () => {
    expect(
      issueEventSchema.parse({ type: 'triage', class: 'database', severity: 'high' }),
    ).toMatchObject({ type: 'triage' });
    expect(
      issueEventSchema.safeParse({ type: 'triage', class: 'backend', severity: 'high' }).success,
    ).toBe(false);
    expect(issueEventSchema.safeParse({ type: 'escalate' }).success).toBe(false);
    expect(issueEventSchema.safeParse({ type: 'escalate', reason: 'x' }).success).toBe(false);
    expect(issueEventSchema.safeParse({ type: 'patch_ready' }).success).toBe(false);
    expect(
      issueEventSchema.safeParse({
        type: 'patch_ready',
        runId: '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60',
      }).success,
    ).toBe(true);
    expect(issueEventSchema.safeParse({ type: 'ops_fixed' }).success).toBe(false);
    expect(
      issueEventSchema.safeParse({
        type: 'ops_fixed',
        runId: '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60',
      }).success,
    ).toBe(true);
    expect(issueEventSchema.safeParse({ type: 'fail', reason: 'sandbox' }).success).toBe(false);
    expect(
      issueEventSchema.safeParse({
        type: 'fail',
        runId: '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60',
        reason: 'The sandbox container did not start.',
      }).success,
    ).toBe(true);
    expect(issueEventSchema.safeParse({ type: 'deploy' }).success).toBe(false);
  });
});
