import { randomUUID } from 'node:crypto';
import {
  APPROVAL_DECISIONS,
  BUG_CLASSES,
  ESCALATION_REASONS,
  ISSUE_STATUSES,
  RUN_STATUSES,
  SEVERITIES,
  STEP_KINDS,
  type IssueStatus,
} from '@page/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { IssuesService } from '../issues/issues.service.ts';
import { isTerminal } from '../issues/transitions.ts';
import { createTestDeps } from './test-utils.ts';

// The migrations copy these lists from @page/contracts into CHECK constraints and the
// issues_open_fingerprint predicate. These tests fail when the two drift apart.

const deps = await createTestDeps();
afterAll(() => deps.close());
const service = new IssuesService(deps.db, deps.fixJobs);

let n = 0;
const insert = (values: { status?: IssueStatus; class?: string; severity?: string }) =>
  deps.db
    .insertInto('issues')
    .values({ fingerprint: `schema-${++n}`, title: 'x', ...values } as never)
    .returning('fingerprint')
    .executeTakeFirstOrThrow();

describe('issues table matches @page/contracts', () => {
  it.each(ISSUE_STATUSES)('accepts status %s', async (status) => {
    await expect(insert({ status })).resolves.toBeDefined();
  });

  it.each(BUG_CLASSES)('accepts class %s', async (cls) => {
    await expect(insert({ class: cls })).resolves.toBeDefined();
  });

  it.each(SEVERITIES)('accepts severity %s', async (severity) => {
    await expect(insert({ severity })).resolves.toBeDefined();
  });

  it('rejects values outside the contracts', async () => {
    await expect(insert({ status: 'done' as IssueStatus })).rejects.toThrow();
    await expect(insert({ class: 'backend' })).rejects.toThrow();
    await expect(insert({ severity: 'urgent' })).rejects.toThrow();
  });

  it.each(ISSUE_STATUSES)('counts a repeat only while the issue is open (%s)', async (status) => {
    const { fingerprint } = await insert({ status });
    const again = await service.report({ fingerprint, title: 'x' });
    expect(again.created).toBe(isTerminal(status));
  });
});

const newRun = async (values: { status?: string; tier?: number } = {}) => {
  const { fingerprint } = await insert({});
  const issue = await deps.db
    .selectFrom('issues')
    .select('id')
    .where('fingerprint', '=', fingerprint)
    .executeTakeFirstOrThrow();
  return deps.db
    .insertInto('runs')
    .values({ id: randomUUID(), issue_id: issue.id, tier: 1, ...values } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
};

describe('runs table matches @page/contracts', () => {
  it.each(RUN_STATUSES)('accepts status %s', async (status) => {
    await expect(newRun({ status })).resolves.toBeDefined();
  });

  it('starts queued', async () => {
    const { id } = await newRun();
    const row = await deps.db.selectFrom('runs').select('status').where('id', '=', id).execute();
    expect(row).toEqual([{ status: 'queued' }]);
  });

  it('rejects an unknown status or tier, and a run with no issue', async () => {
    await expect(newRun({ status: 'done' })).rejects.toThrow();
    await expect(newRun({ tier: 4 })).rejects.toThrow();
    await expect(
      deps.db
        .insertInto('runs')
        .values({ id: randomUUID(), issue_id: randomUUID(), tier: 1 })
        .execute(),
    ).rejects.toThrow();
  });
});

describe('steps table matches @page/contracts', () => {
  const step = (values: { kind?: string; seq?: number; run_id?: string } = {}) =>
    deps.db
      .insertInto('steps')
      .values({
        run_id: randomUUID(),
        seq: 0,
        kind: 'exec',
        input: 'pnpm test',
        exit_code: 0,
        allowed: true,
        ...values,
      } as never)
      .execute();

  it.each(STEP_KINDS)('accepts kind %s', async (kind) => {
    await expect(step({ kind })).resolves.toBeDefined();
  });

  it('rejects an unknown kind, a negative seq and a repeated (run_id, seq)', async () => {
    await expect(step({ kind: 'shell' })).rejects.toThrow();
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
  const escalate = async (values: { reason?: string; from_tier?: number; to_tier?: number }) => {
    const { id } = await newRun();
    return deps.db
      .insertInto('escalations')
      .values({
        run_id: id,
        from_tier: 1,
        to_tier: 2,
        reason: 'tests_failing',
        note,
        ...values,
      } as never)
      .execute();
  };

  it.each(ESCALATION_REASONS)('accepts reason %s', async (reason) => {
    await expect(escalate({ reason })).resolves.toBeDefined();
  });

  it('rejects an unknown reason and a target tier that is not higher', async () => {
    await expect(escalate({ reason: 'tired' })).rejects.toThrow();
    await expect(escalate({ from_tier: 2, to_tier: 2 })).rejects.toThrow();
    await expect(escalate({ from_tier: 3, to_tier: 1 })).rejects.toThrow();
  });
});

describe('approvals table matches @page/contracts', () => {
  const request = async (values: Record<string, unknown> = {}) => {
    const { id } = await newRun({ tier: 3 });
    return deps.db
      .insertInto('approvals')
      .values({ run_id: id, action: 'ops.restart', ...values })
      .execute();
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
    await expect(request({ decision: 'maybe', ...decided })).rejects.toThrow();
  });

  it('rejects an empty action or decider', async () => {
    await expect(request({ action: '' })).rejects.toThrow();
    await expect(request({ decision: 'approved', ...decided, decided_by: '' })).rejects.toThrow();
  });
});
