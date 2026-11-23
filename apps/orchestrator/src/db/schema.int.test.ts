import { randomUUID } from 'node:crypto';
import {
  approvalSchema,
  escalationSchema,
  issueEventRecordSchema,
  issueSchema,
  runSchema,
  stepSchema,
} from '@page/contracts';
import { confidenceFixture } from '@page/contracts/fixtures';
import { afterAll, describe, expect, it } from 'vitest';
import { IssuesService } from '../issues/issues.service.ts';
import { createSchemaDeps } from './test-utils.ts';

// Writes a row to every table on real Postgres, reads it back and parses it with the
// @page/contracts row schema, so a column type or name that drifts from the contracts fails.
// Issues and their events go through IssuesService, the code the API runs. The other
// tables have no service yet, so their rows are mapped here.

const deps = await createSchemaDeps();
afterAll(() => deps.close());
const { db } = deps;
const service = new IssuesService(db, deps.fixJobs, deps.logger);

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

const issueOf = async (runId: string) =>
  (await db.selectFrom('runs').select('issue_id').where('id', '=', runId).executeTakeFirstOrThrow())
    .issue_id;

const inAMinute = () => new Date(Date.now() + 60_000);

describe('orchestrator tables on real Postgres', () => {
  it('stores an issue and its events through IssuesService, as contracts records', async () => {
    const fingerprint = `int-${randomUUID()}`;
    const { issue: reported, created } = await service.report({
      fingerprint,
      title: 'TypeError: boom',
    });
    expect(created).toBe(true);
    await service.apply(reported.id, { type: 'triage', class: 'backend-api', severity: 'high' });
    const fixing = await service.apply(reported.id, { type: 'start_fix' });

    const issue = issueSchema.parse(await service.get(reported.id));
    expect(issue).toEqual(fixing);
    expect(issue).toMatchObject({
      id: reported.id,
      fingerprint,
      title: 'TypeError: boom',
      status: 'fixing',
      class: 'backend-api',
      severity: 'high',
      occurrences: 1,
      currentTier: 1,
      createdAt: reported.createdAt,
    });
    expect(Date.parse(issue.updatedAt)).toBeGreaterThanOrEqual(Date.parse(issue.createdAt));
    // Entering a tier queued a fix job, so the row names its run.
    const row = await db
      .selectFrom('issues')
      .select('current_run_id')
      .where('id', '=', reported.id)
      .executeTakeFirstOrThrow();
    expect(row.current_run_id).not.toBeNull();

    const events = (await service.events(reported.id)).map((e) => issueEventRecordSchema.parse(e));
    // A double-encoded jsonb event would come back as a string and fail the toEqual.
    expect(events.map((e) => [e.event, e.fromStatus, e.toStatus, e.currentTier])).toEqual([
      [{ type: 'triage', class: 'backend-api', severity: 'high' }, 'new', 'triaged', null],
      [{ type: 'start_fix' }, 'triaged', 'fixing', 1],
    ]);
    // node-postgres returns bigint as a string, so ids past 2^53 keep their precision.
    // toEventRecord's String() would hide a type parser that turned them into numbers.
    const ids = await db
      .selectFrom('issue_events')
      .select('id')
      .where('issue_id', '=', reported.id)
      .execute();
    expect(ids.map((r) => typeof r.id)).toEqual(['string', 'string']);
  });

  it('stores a run that parses as a contracts Run', async () => {
    const id = await newRun(2);
    await db
      .updateTable('runs')
      .set({
        status: 'succeeded',
        started_at: new Date('2026-11-08T10:00:00Z'),
        finished_at: new Date('2026-11-08T10:05:00Z'),
        pr_url: 'https://github.com/atontalapur/page-demo/pull/5',
        confidence: JSON.stringify(confidenceFixture),
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
      confidence: confidenceFixture,
    });
  });

  it('stores steps that parse as contracts Steps, in seq order', async () => {
    const runId = await newRun();
    await db
      .insertInto('steps')
      .values([
        {
          run_id: runId,
          seq: 1,
          kind: 'edit',
          input: 'src/a.ts',
          exit_code: 0,
          allowed: true,
          thought: 'Fix the import.',
        },
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
        thought: row.thought,
        createdAt: iso(row.created_at),
      }),
    );
    expect(steps.map((s) => [s.seq, s.kind, s.allowed, s.outputTrimmed, s.thought])).toEqual([
      [0, 'exec', false, '', null],
      [1, 'edit', true, '', 'Fix the import.'],
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
      .values({
        run_id: runId,
        issue_id: await issueOf(runId),
        action: 'ops.restart',
        args: JSON.stringify({ dryRun: false }),
        expires_at: inAMinute(),
        reason: 'The app needs a restart to load the fix.',
      })
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
        issueId: row.issue_id,
        action: row.action,
        args: row.args,
        decision: row.decision,
        decidedBy: row.decided_by,
        decidedAt: iso(row.decided_at),
        requestedAt: iso(row.requested_at),
        expiresAt: iso(row.expires_at),
        reason: row.reason,
      });
    };

    expect(await read()).toMatchObject({
      decision: 'pending',
      args: { dryRun: false },
      reason: 'The app needs a restart to load the fix.',
    });
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
    const issue_id = await issueOf(runId);
    await db
      .insertInto('approvals')
      .values({ run_id: runId, issue_id, action: 'ops.restart', expires_at: inAMinute() })
      .execute();

    // 23001 is restrict_violation: ON DELETE RESTRICT, not a missing row or a cascade.
    const deleteIssue = () => db.deleteFrom('issues').where('id', '=', issue_id).execute();
    const deleteRun = () => db.deleteFrom('runs').where('id', '=', runId).execute();
    await expect(deleteIssue()).rejects.toMatchObject({ code: '23001' });
    // The escalation holds the run; an approval doesn't (009).
    await expect(deleteRun()).rejects.toMatchObject({ code: '23001' });

    const runs = await db.selectFrom('runs').select('id').where('id', '=', runId).execute();
    const escalations = await db
      .selectFrom('escalations')
      .select('id')
      .where('run_id', '=', runId)
      .execute();
    expect([runs.length, escalations.length]).toEqual([1, 1]);

    // An approval holds its issue with no runs row: a run in progress asks before it has one.
    const asking = await db
      .insertInto('issues')
      .values({ fingerprint: `int-${randomUUID()}`, title: 'x', status: 'fixing', current_tier: 3 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('approvals')
      .values({
        run_id: randomUUID(),
        issue_id: asking.id,
        action: 'ops.restart',
        expires_at: inAMinute(),
      })
      .execute();
    await expect(
      db.deleteFrom('issues').where('id', '=', asking.id).execute(),
    ).rejects.toMatchObject({ code: '23001' });

    // An issue's event log holds it too, even with no runs.
    const { issue } = await service.report({ fingerprint: `int-${randomUUID()}`, title: 'x' });
    await service.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
    await expect(
      db.deleteFrom('issues').where('id', '=', issue.id).execute(),
    ).rejects.toMatchObject({ code: '23001' });
    expect(await service.events(issue.id)).toHaveLength(1);
  });
});
