import { describe, expect, it } from 'vitest';
import {
  confidenceFixture,
  decidedApprovalFixture,
  escalationFixture,
  issueFixture,
  pendingApprovalFixture,
  runFixture,
  stepFixture,
} from './__fixtures__/index.ts';
import {
  approvalSchema,
  approverNameSchema,
  deciderFor,
  escalationSchema,
  issueSchema,
  runSchema,
  stepSchema,
  SYSTEM_DECIDERS,
} from './db.ts';
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

  it('rejects a non-uuid id', () => {
    expect(() => issueSchema.parse({ ...issueFixture, id: '42' })).toThrow();
  });

  it.each([
    [
      'a Postgres to_json timestamptz',
      '2026-10-30T12:00:00.123456+00:00',
      '2026-10-30T12:00:00.123Z',
    ],
    ['a non-UTC offset', '2026-10-30T14:00:00+02:00', '2026-10-30T12:00:00.000Z'],
  ])('normalizes %s to UTC', (_, createdAt, expected) => {
    expect(issueSchema.parse({ ...issueFixture, createdAt }).createdAt).toBe(expected);
  });

  it('rejects a timestamp with no offset', () => {
    expect(() =>
      issueSchema.parse({ ...issueFixture, createdAt: '2026-10-30T12:00:00' }),
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

  it('round-trips a scored run, and rejects a confidence score outside 0 to 1', () => {
    const scored = { ...runFixture, confidence: confidenceFixture };
    expect(roundTrip(runSchema, scored)).toEqual(scored);
    const confidence = { ...confidenceFixture, score: 1.2 };
    expect(() => runSchema.parse({ ...runFixture, confidence })).toThrow();
  });

  it('rejects confidence parts it does not know, such as a self-assessment', () => {
    const confidence = { ...confidenceFixture, selfAssessed: 0.9 };
    expect(() => runSchema.parse({ ...runFixture, confidence })).toThrow();
  });

  it('accepts an https github.com prUrl', () => {
    const run = { ...runFixture, prUrl: 'https://github.com/atontalapur/page-demo/pull/7' };
    expect(roundTrip(runSchema, run)).toEqual(run);
  });

  it.each([
    'javascript:alert(1)',
    'http://github.com/atontalapur/page-demo/pull/7',
    'https://github.com.evil.example/pull/7',
    'https://github.com@evil.example/pull/7',
  ])('rejects the prUrl %s', (prUrl) => {
    expect(() => runSchema.parse({ ...runFixture, prUrl })).toThrow();
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

  it('accepts a low_confidence escalation and rejects an unknown reason', () => {
    const low = { ...escalationFixture, toTier: 2, reason: 'low_confidence' };
    expect(roundTrip(escalationSchema, low)).toEqual(low);
    expect(() => escalationSchema.parse({ ...escalationFixture, reason: 'unsure' })).toThrow();
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

  it('needs the issue and the deadline', () => {
    expect(() => approvalSchema.parse({ ...pendingApprovalFixture, issueId: undefined })).toThrow();
    expect(() =>
      approvalSchema.parse({ ...pendingApprovalFixture, expiresAt: undefined }),
    ).toThrow();
  });
});

describe('approverNameSchema', () => {
  it.each(['Arjun', 'Nidheesh K.', "O'Brien", 'ana-maria_2', '  Daniyal  ', 'José'])(
    'takes %j',
    (name) => {
      expect(approverNameSchema.parse(name)).toBe(name.trim());
    },
  );

  it.each(['', '   ', 'system:timed_out', 'ui:arjun', '-arjun', 'a'.repeat(41), 'x<script>'])(
    'refuses %j',
    (name) => {
      expect(approverNameSchema.safeParse(name).success).toBe(false);
    },
  );

  it('keeps a person apart from the server', () => {
    const people = deciderFor('arjun');
    expect(people).toBe('ui:arjun');
    expect(Object.values(SYSTEM_DECIDERS)).not.toContain(people);
    for (const system of Object.values(SYSTEM_DECIDERS)) {
      expect(approverNameSchema.safeParse(system).success).toBe(false);
    }
  });
});
