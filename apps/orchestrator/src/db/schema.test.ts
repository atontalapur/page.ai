import { randomUUID } from 'node:crypto';
import {
  APPROVAL_DECISIONS,
  BUG_CLASSES,
  ESCALATION_REASONS,
  ISSUE_STATUSES,
  RUN_STATUSES,
  SEVERITIES,
  STEP_KINDS,
} from '@page/contracts';
import type { Insertable } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { IssuesService } from '../issues/issues.service.ts';
import { isTerminal } from '../issues/transitions.ts';
import type {
  ApprovalsTable,
  EscalationsTable,
  IssuesTable,
  RunsTable,
  StepsTable,
} from './database.ts';
import { createTestDeps } from './test-utils.ts';

// The migrations copy these lists from @page/contracts into CHECK constraints and the
// issues_open_fingerprint predicate. These tests fail when the two drift apart.
//
// Each helper takes typed values, so Kysely still checks every column name. A value the
// schema must reject is cast on its own with `bad()`.

const deps = await createTestDeps();
afterAll(() => deps.close());
const { db } = deps;
const service = new IssuesService(db, deps.fixJobs);

/** A value of the wrong type for its column, for a test that expects the insert to fail. */
const bad = (value: unknown) => value as never;

let n = 0;
const insertIssue = (values: Partial<Insertable<IssuesTable>> = {}) =>
  db
    .insertInto('issues')
    .values({ fingerprint: `schema-${++n}`, title: 'x', ...values })
    .returning(['id', 'fingerprint'])
    .executeTakeFirstOrThrow();

describe('issues table matches @page/contracts', () => {
  it.each(ISSUE_STATUSES)('accepts status %s', async (status) => {
    await expect(insertIssue({ status })).resolves.toBeDefined();
  });

  it.each(BUG_CLASSES)('accepts class %s', async (cls) => {
    await expect(insertIssue({ class: cls })).resolves.toBeDefined();
  });

  it.each(SEVERITIES)('accepts severity %s', async (severity) => {
    await expect(insertIssue({ severity })).resolves.toBeDefined();
  });

  it('rejects values outside the contracts', async () => {
    await expect(insertIssue({ status: bad('done') })).rejects.toThrow();
    await expect(insertIssue({ class: bad('backend') })).rejects.toThrow();
    await expect(insertIssue({ severity: bad('urgent') })).rejects.toThrow();
  });

  it.each(ISSUE_STATUSES)('counts a repeat only while the issue is open (%s)', async (status) => {
    const { fingerprint } = await insertIssue({ status });
    const again = await service.report({ fingerprint, title: 'x' });
    expect(again.created).toBe(isTerminal(status));
  });
});

const newRun = async (values: Partial<Insertable<RunsTable>> = {}) => {
  const issue = await insertIssue();
  return db
    .insertInto('runs')
    .values({ id: randomUUID(), issue_id: issue.id, tier: 1, ...values })
    .returning(['id', 'issue_id'])
    .executeTakeFirstOrThrow();
};

describe('runs table matches @page/contracts', () => {
  it.each(RUN_STATUSES)('accepts status %s', async (status) => {
    await expect(newRun({ status })).resolves.toBeDefined();
  });

  it('starts queued', async () => {
    const { id } = await newRun();
    const row = await db.selectFrom('runs').select('status').where('id', '=', id).execute();
    expect(row).toEqual([{ status: 'queued' }]);
  });

  it('rejects an unknown status, a tier outside 1-3 and a run with no issue', async () => {
    await expect(newRun({ status: bad('done') })).rejects.toThrow();
    await expect(newRun({ tier: bad(0) })).rejects.toThrow();
    await expect(newRun({ tier: bad(4) })).rejects.toThrow();
    await expect(newRun({ issue_id: randomUUID() })).rejects.toThrow();
  });

  it('accepts confidence only as an object', async () => {
    const confidence = { score: 1, reproduced: true, testsPass: true, selfAssessed: 1 };
    await expect(newRun({ confidence: JSON.stringify(confidence) })).resolves.toBeDefined();
    await expect(newRun({ confidence: null })).resolves.toBeDefined();
    await expect(newRun({ confidence: '[]' })).rejects.toThrow();
    await expect(newRun({ confidence: '0.9' })).rejects.toThrow();
  });

  it("won't delete an issue that has runs", async () => {
    const { issue_id } = await newRun();
    await expect(db.deleteFrom('issues').where('id', '=', issue_id).execute()).rejects.toThrow();
  });
});

describe('steps table matches @page/contracts', () => {
  const step = (values: Partial<Insertable<StepsTable>> = {}) =>
    db
      .insertInto('steps')
      .values({
        run_id: randomUUID(),
        seq: 0,
        kind: 'exec',
        input: 'pnpm test',
        exit_code: 0,
        allowed: true,
        ...values,
      })
      .execute();

  it.each(STEP_KINDS)('accepts kind %s', async (kind) => {
    await expect(step({ kind })).resolves.toBeDefined();
  });

  it('rejects an unknown kind, a negative seq and a repeated (run_id, seq)', async () => {
    await expect(step({ kind: bad('shell') })).rejects.toThrow();
    await expect(step({ seq: -1 })).rejects.toThrow();
    const runId = randomUUID();
    await step({ run_id: runId, seq: 3 });
    await expect(step({ run_id: runId, seq: 3 })).rejects.toThrow();
  });

  it('needs no runs row, so the audit write never fails on a missing parent', async () => {
    await expect(step()).resolves.toBeDefined();
  });
});

const note = JSON.stringify({ summary: 'x', tried: [], blocker: 'y' });

describe('escalations table matches @page/contracts', () => {
  const escalate = async (values: Partial<Insertable<EscalationsTable>> = {}) => {
    const { id } = await newRun();
    return db
      .insertInto('escalations')
      .values({ run_id: id, from_tier: 1, to_tier: 2, reason: 'tests_failing', note, ...values })
      .returning('run_id')
      .executeTakeFirstOrThrow();
  };

  it.each(ESCALATION_REASONS)('accepts reason %s', async (reason) => {
    await expect(escalate({ reason })).resolves.toBeDefined();
  });

  it('rejects an unknown reason and a target tier that is not higher', async () => {
    await expect(escalate({ reason: bad('tired') })).rejects.toThrow();
    await expect(escalate({ from_tier: 2, to_tier: 2 })).rejects.toThrow();
    await expect(escalate({ from_tier: 3, to_tier: 1 })).rejects.toThrow();
  });

  it('rejects tiers outside 1-3 even when the target is higher', async () => {
    await expect(escalate({ from_tier: bad(0), to_tier: 1 })).rejects.toThrow();
    await expect(escalate({ from_tier: 3, to_tier: bad(4) })).rejects.toThrow();
  });

  it('accepts the note only as an object', async () => {
    await expect(escalate({ note: '"tried things"' })).rejects.toThrow();
    await expect(escalate({ note: '[]' })).rejects.toThrow();
  });

  it("won't delete a run that has escalations", async () => {
    const { run_id } = await escalate();
    await expect(db.deleteFrom('runs').where('id', '=', run_id).execute()).rejects.toThrow();
  });
});

describe('approvals table matches @page/contracts', () => {
  const request = async (values: Partial<Insertable<ApprovalsTable>> = {}) => {
    const { id } = await newRun({ tier: 3 });
    return db
      .insertInto('approvals')
      .values({ run_id: id, action: 'ops.restart', ...values })
      .returning('run_id')
      .executeTakeFirstOrThrow();
  };
  const decided = { decided_by: 'reviewer', decided_at: new Date() };

  it('accepts a pending approval with no decider', async () => {
    await expect(request()).resolves.toBeDefined();
  });

  it.each(APPROVAL_DECISIONS)(
    'accepts a %s approval with its decider and time',
    async (decision) => {
      await expect(request({ decision, ...decided })).resolves.toBeDefined();
    },
  );

  it('rejects a decision without a decider or time, and a pending one with them', async () => {
    await expect(request({ decision: 'approved' })).rejects.toThrow();
    await expect(request({ decision: 'approved', decided_by: 'reviewer' })).rejects.toThrow();
    await expect(request({ decision: 'pending', ...decided })).rejects.toThrow();
    await expect(request({ decision: bad('maybe'), ...decided })).rejects.toThrow();
  });

  it('rejects an empty action or decider', async () => {
    await expect(request({ action: '' })).rejects.toThrow();
    await expect(request({ decision: 'approved', ...decided, decided_by: '' })).rejects.toThrow();
  });

  it('accepts args only as an object', async () => {
    await expect(request({ args: JSON.stringify({ dryRun: true }) })).resolves.toBeDefined();
    await expect(request({ args: '[]' })).rejects.toThrow();
    await expect(request({ args: '"restart"' })).rejects.toThrow();
  });

  it("won't delete a run that has approvals", async () => {
    const { run_id } = await request();
    await expect(db.deleteFrom('runs').where('id', '=', run_id).execute()).rejects.toThrow();
  });
});
