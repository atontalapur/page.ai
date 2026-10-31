import { describe, expect, it } from 'vitest';
import {
  decidedApprovalFixture,
  escalationFixture,
  issueFixture,
  pendingApprovalFixture,
  runFixture,
  stepFixture,
} from './__fixtures__/index.ts';
import { approvalSchema, escalationSchema, issueSchema, runSchema, stepSchema } from './db.ts';
import { roundTrip } from './test-utils.ts';

describe('issueSchema', () => {
  it('round-trips the fixture', () => {
    expect(roundTrip(issueSchema, issueFixture)).toEqual(issueFixture);
  });

  it('accepts an untriaged issue with no class, severity or tier', () => {
    const untriaged = {
      ...issueFixture,
      status: 'new',
      class: null,
      severity: null,
      currentTier: null,
    };
    expect(roundTrip(issueSchema, untriaged)).toEqual(untriaged);
  });

  it('rejects a missing fingerprint', () => {
    expect(() => issueSchema.parse({ ...issueFixture, fingerprint: undefined })).toThrow();
  });

  it('rejects an unknown status or severity', () => {
    expect(() => issueSchema.parse({ ...issueFixture, status: 'open' })).toThrow();
    expect(() => issueSchema.parse({ ...issueFixture, severity: 'p1' })).toThrow();
  });

  it('rejects a non-uuid id and a timestamp with an offset', () => {
    expect(() => issueSchema.parse({ ...issueFixture, id: '42' })).toThrow();
    expect(() =>
      issueSchema.parse({ ...issueFixture, createdAt: '2026-10-30T12:00:00+02:00' }),
    ).toThrow();
  });
});

describe('runSchema', () => {
  it('round-trips the fixture', () => {
    expect(roundTrip(runSchema, runFixture)).toEqual(runFixture);
  });

  it('rejects an unknown tier', () => {
    expect(() => runSchema.parse({ ...runFixture, tier: 4 })).toThrow();
  });
});

describe('stepSchema', () => {
  it('round-trips the fixture', () => {
    expect(roundTrip(stepSchema, stepFixture)).toEqual(stepFixture);
  });

  it('accepts a refused step with no exit code', () => {
    const refused = { ...stepFixture, input: 'sudo rm -rf /', allowed: false, exitCode: null };
    expect(roundTrip(stepSchema, refused)).toEqual(refused);
  });

  it('rejects a missing allowed flag', () => {
    expect(() => stepSchema.parse({ ...stepFixture, allowed: undefined })).toThrow();
  });
});

describe('escalationSchema', () => {
  it('round-trips the fixture', () => {
    expect(roundTrip(escalationSchema, escalationFixture)).toEqual(escalationFixture);
  });

  it('rejects an escalation that does not move up a tier', () => {
    expect(() => escalationSchema.parse({ ...escalationFixture, toTier: 1 })).toThrow();
  });
});

describe('approvalSchema', () => {
  it('round-trips pending and decided fixtures', () => {
    expect(roundTrip(approvalSchema, pendingApprovalFixture)).toEqual(pendingApprovalFixture);
    expect(roundTrip(approvalSchema, decidedApprovalFixture)).toEqual(decidedApprovalFixture);
  });

  it('rejects a decision without who and when', () => {
    expect(() => approvalSchema.parse({ ...decidedApprovalFixture, decidedBy: null })).toThrow();
    expect(() => approvalSchema.parse({ ...decidedApprovalFixture, decidedAt: null })).toThrow();
  });

  it('rejects a pending approval that already has a decider', () => {
    expect(() => approvalSchema.parse({ ...pendingApprovalFixture, decidedBy: 'arjun' })).toThrow();
  });
});
