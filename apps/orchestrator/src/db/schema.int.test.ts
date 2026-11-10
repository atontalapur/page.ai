import { randomUUID } from 'node:crypto';
import {
  approvalSchema,
  escalationSchema,
  issueEventRecordSchema,
  issueSchema,
  runSchema,
  stepSchema,
  type IssueEvent,
} from '@page/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { toEventRecord, toIssue } from '../issues/issues.service.ts';
import { createSchemaDeps } from './test-utils.ts';

// Writes a row to every table on real Postgres, reads it back and parses it with the
// @page/contracts row schema, so a column type or name that drifts from the contracts fails.

const deps = await createSchemaDeps();
afterAll(() => deps.close());
const { db } = deps;

const iso = (date: Date | null) => date?.toISOString() ?? null;

async function newRun(tier: 1 | 2 | 3 = 1): Promise<string> {
  const issue = await db
    .insertInto('issues')
    .values({ fingerprint: `int-${randomUUID()}`, title: 'TypeError: boom' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const run = await db
    .insertInto('runs')
    .values({ id: randomUUID(), issue_id: issue.id, tier })
    .returning('id')
    .executeTakeFirstOrThrow();
  return run.id;
}

describe('orchestrator tables on real Postgres', () => {
  it('stores an issue that parses as a contracts Issue', async () => {
    const { id } = await db
      .insertInto('issues')
      .values({
        fingerprint: `int-${randomUUID()}`,
        title: 'TypeError: boom',
        status: 'fixing',
        class: 'backend-api',
        severity: 'high',
        current_tier: 2,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const row = await db
      .selectFrom('issues')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(issueSchema.parse(toIssue(row))).toMatchObject({
      id,
      status: 'fixing',
      class: 'backend-api',
      severity: 'high',
      occurrences: 1,
      currentTier: 2,
    });
  });

  it('stores issue events that parse as contracts IssueEventRecords, in order', async () => {
    const { id: issueId } = await db
      .insertInto('issues')
      .values({ fingerprint: `int-${randomUUID()}`, title: 'TypeError: boom' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const events: { event: IssueEvent; from: 'new' | 'triaged'; to: 'triaged' | 'fixing' }[] = [
      { event: { type: 'triage', class: 'frontend', severity: 'low' }, from: 'new', to: 'triaged' },
      { event: { type: 'start_fix' }, from: 'triaged', to: 'fixing' },
    ];
    for (const [i, { event, from, to }] of events.entries()) {
      await db
        .insertInto('issue_events')
        .values({
          issue_id: issueId,
          event: JSON.stringify(event),
          from_status: from,
          to_status: to,
          current_tier: i === 0 ? null : 1,
        })
        .execute();
    }

    const rows = await db
      .selectFrom('issue_events')
      .selectAll()
      .where('issue_id', '=', issueId)
      .orderBy('id')
      .execute();
    // node-postgres returns the bigint id as a string; PGlite, in the unit tests, as a number.
    const records = rows.map((row) => issueEventRecordSchema.parse(toEventRecord(row)));
    expect(records.map((r) => r.event)).toEqual(events.map((e) => e.event));
    expect(records.map((r) => [r.fromStatus, r.toStatus, r.currentTier])).toEqual([
      ['new', 'triaged', null],
      ['triaged', 'fixing', 1],
    ]);
    expect(BigInt(records[1]!.id)).toBeGreaterThan(BigInt(records[0]!.id));
  });

  it('stores a run that parses as a contracts Run', async () => {
    const id = await newRun(2);
    const confidence = { score: 0.8, reproduced: true, testsPass: true, selfAssessed: 0.7 };
    await db
      .updateTable('runs')
      .set({
        status: 'succeeded',
        started_at: new Date('2026-11-08T10:00:00Z'),
        finished_at: new Date('2026-11-08T10:05:00Z'),
        pr_url: 'https://github.com/atontalapur/page-demo/pull/5',
        confidence: JSON.stringify(confidence),
      })
      .where('id', '=', id)
      .execute();

    const row = await db
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(
      runSchema.parse({
        id: row.id,
        issueId: row.issue_id,
        tier: row.tier,
        status: row.status,
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        prUrl: row.pr_url,
        confidence: row.confidence,
      }),
    ).toMatchObject({
      tier: 2,
      status: 'succeeded',
      startedAt: '2026-11-08T10:00:00.000Z',
      confidence,
    });
  });

  it('stores steps that parse as contracts Steps, in seq order', async () => {
    const runId = await newRun();
    await db
      .insertInto('steps')
      .values([
        { run_id: runId, seq: 1, kind: 'edit', input: 'src/a.ts', exit_code: 0, allowed: true },
        { run_id: runId, seq: 0, kind: 'exec', input: 'curl x', exit_code: null, allowed: false },
      ])
      .execute();

    const rows = await db
      .selectFrom('steps')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('seq')
      .execute();
    const steps = rows.map((row) =>
      stepSchema.parse({
        runId: row.run_id,
        seq: row.seq,
        kind: row.kind,
        input: row.input,
        outputTrimmed: row.output_trimmed,
        exitCode: row.exit_code,
        allowed: row.allowed,
        createdAt: iso(row.created_at),
      }),
    );
    expect(steps.map((s) => [s.seq, s.kind, s.allowed, s.outputTrimmed])).toEqual([
      [0, 'exec', false, ''],
      [1, 'edit', true, ''],
    ]);
  });

  it('stores an escalation that parses as a contracts Escalation', async () => {
    const runId = await newRun();
    const note = { summary: 'needs a migration', tried: ['edited orders.ts'], blocker: 'tier 1' };
    const { id } = await db
      .insertInto('escalations')
      .values({
        run_id: runId,
        from_tier: 1,
        to_tier: 2,
        reason: 'needs_higher_tier',
        note: JSON.stringify(note),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const row = await db
      .selectFrom('escalations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(
      escalationSchema.parse({
        id: row.id,
        runId: row.run_id,
        fromTier: row.from_tier,
        toTier: row.to_tier,
        reason: row.reason,
        note: row.note,
        createdAt: iso(row.created_at),
      }),
    ).toMatchObject({ fromTier: 1, toTier: 2, note });
  });

  it('stores pending and decided approvals that parse as contracts Approvals', async () => {
    const runId = await newRun(3);
    const { id } = await db
      .insertInto('approvals')
      .values({ run_id: runId, action: 'ops.restart', args: JSON.stringify({ dryRun: false }) })
      .returning('id')
      .executeTakeFirstOrThrow();

    const read = async () => {
      const row = await db
        .selectFrom('approvals')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return approvalSchema.parse({
        id: row.id,
        runId: row.run_id,
        action: row.action,
        args: row.args,
        decision: row.decision,
        decidedBy: row.decided_by,
        decidedAt: iso(row.decided_at),
        requestedAt: iso(row.requested_at),
      });
    };

    expect(await read()).toMatchObject({ decision: 'pending', args: { dryRun: false } });
    await db
      .updateTable('approvals')
      .set({ decision: 'approved', decided_by: 'reviewer', decided_at: new Date() })
      .where('id', '=', id)
      .execute();
    expect(await read()).toMatchObject({ decision: 'approved', decidedBy: 'reviewer' });
  });

  it('keeps the audit record: an issue or run with history cannot be deleted', async () => {
    const runId = await newRun(3);
    const note = JSON.stringify({ summary: 'x', tried: [], blocker: 'y' });
    await db
      .insertInto('escalations')
      .values({ run_id: runId, from_tier: 2, to_tier: 3, reason: 'needs_higher_tier', note })
      .execute();
    await db.insertInto('approvals').values({ run_id: runId, action: 'ops.restart' }).execute();
    const { issue_id } = await db
      .selectFrom('runs')
      .select('issue_id')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();

    // 23001 is restrict_violation: ON DELETE RESTRICT, not a missing row or a cascade.
    const deleteIssue = () => db.deleteFrom('issues').where('id', '=', issue_id).execute();
    const deleteRun = () => db.deleteFrom('runs').where('id', '=', runId).execute();
    await expect(deleteIssue()).rejects.toMatchObject({ code: '23001' });
    await expect(deleteRun()).rejects.toMatchObject({ code: '23001' });
    await db.deleteFrom('approvals').where('run_id', '=', runId).execute();
    // The escalation alone still holds the run.
    await expect(deleteRun()).rejects.toMatchObject({ code: '23001' });

    const runs = await db.selectFrom('runs').select('id').where('id', '=', runId).execute();
    const escalations = await db
      .selectFrom('escalations')
      .select('id')
      .where('run_id', '=', runId)
      .execute();
    expect([runs.length, escalations.length]).toEqual([1, 1]);
  });
});
