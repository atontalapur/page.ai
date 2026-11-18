import { randomUUID } from 'node:crypto';
import { escalationNoteFixture } from '@page/contracts/fixtures';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { createLogger } from '../logger.ts';
import { FIX_QUEUE, type FixJob } from '../queue/fix-jobs.ts';
import { issueEventFor, RunsService, type RunFinishedJob } from './runs.service.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger);
const runs = new RunsService(deps.db, issues, deps.logger);

const report = 'GET /\n\nRangeError: Invalid currency code : US';
let n = 0;

/** An issue in `fixing` at tier 1, and its fix job as the daemon would claim it. */
async function fixing() {
  const { issue } = await issues.report({ fingerprint: `runs-${++n}`, title: 'Boom' }, report);
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  await issues.apply(issue.id, { type: 'start_fix' });
  return { issue, job: await liveJob(issue.id) };
}

async function liveJob(issueId: string): Promise<FixJob> {
  const jobs = await deps.boss.findJobs<FixJob>(FIX_QUEUE, { data: { issueId } });
  const live = jobs.filter((j) => j.state !== 'cancelled');
  expect(live).toHaveLength(1);
  return live[0]!.data;
}

const at = '2026-11-18T10:00:00.000Z';
const later = '2026-11-18T10:09:00.000Z';

function finished(job: FixJob, result: Partial<RunFinishedJob['result']> = {}): RunFinishedJob {
  return {
    v: 1,
    issueId: job.issueId,
    tier: job.tier,
    startedAt: at,
    finishedAt: later,
    diff: null,
    result: {
      v: 1,
      runId: job.runId,
      status: 'succeeded',
      prUrl: null,
      confidence: null,
      note: null,
      ...result,
    } as RunFinishedJob['result'],
  };
}

const escalation = {
  status: 'escalated',
  reason: 'budget_exhausted',
  toTier: 2,
  note: escalationNoteFixture,
} as const;

const runRow = (id: string) =>
  deps.db.selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirst();

describe('RunsService', () => {
  it('records a succeeded run and moves the issue to awaiting_approval', async () => {
    const { issue, job } = await fixing();
    const diff = '--- a/src/shop/money.ts\n+++ b/src/shop/money.ts\n';
    const outcome = await runs.record({ ...finished(job), diff });

    expect(outcome).toEqual({ kind: 'applied', event: 'patch_ready' });
    expect(await issues.get(issue.id)).toMatchObject({
      status: 'awaiting_approval',
      currentTier: 1,
    });
    expect(await runRow(job.runId)).toMatchObject({
      issue_id: issue.id,
      tier: 1,
      status: 'succeeded',
      started_at: new Date(at),
      finished_at: new Date(later),
      pr_url: null,
      confidence: null,
      diff,
    });
  });

  it('keeps the PR link and the confidence of a run', async () => {
    const { job } = await fixing();
    const prUrl = 'https://github.com/atontalapur/page-demo/pull/7';
    const confidence = { score: 0.9, reproduced: true, testsPass: true, selfAssessed: 0.8 };
    await runs.record(finished(job, { prUrl, confidence }));
    expect(await runRow(job.runId)).toMatchObject({ pr_url: prUrl, confidence });
  });

  it('escalates: writes the escalation and queues the next tier with report and note', async () => {
    const { issue, job } = await fixing();
    expect(await runs.record(finished(job, escalation))).toEqual({
      kind: 'applied',
      event: 'escalate',
    });

    expect(await issues.get(issue.id)).toMatchObject({ status: 'fixing', currentTier: 2 });
    const next = await liveJob(issue.id);
    expect(next).toMatchObject({ tier: 2, report, escalationNote: escalationNoteFixture });
    expect(next.runId).not.toBe(job.runId);
    const [old] = await deps.boss.findJobs(FIX_QUEUE, { id: job.runId });
    expect(old?.state).toBe('cancelled');

    const escalations = await deps.db
      .selectFrom('escalations')
      .selectAll()
      .where('run_id', '=', job.runId)
      .execute();
    expect(escalations).toEqual([
      expect.objectContaining({
        from_tier: 1,
        to_tier: 2,
        reason: 'budget_exhausted',
        note: escalationNoteFixture,
      }),
    ]);
    expect((await runRow(job.runId))?.status).toBe('escalated');
    const events = await issues.events(issue.id);
    expect(events.at(-1)?.event).toEqual({
      type: 'escalate',
      runId: job.runId,
      reason: `budget_exhausted: ${escalationNoteFixture.summary}`,
    });
  });

  it('records a retried result once and leaves the issue where the first one put it', async () => {
    const { issue, job } = await fixing();
    const result = finished(job, escalation);
    await runs.record(result);
    expect(await runs.record(result)).toEqual({ kind: 'stale' });

    expect(await issues.get(issue.id)).toMatchObject({ status: 'fixing', currentTier: 2 });
    const all = await deps.boss.findJobs<FixJob>(FIX_QUEUE, { data: { issueId: issue.id } });
    expect(all.map((j) => j.data.tier).sort()).toEqual([1, 2]);
    const escalations = await deps.db
      .selectFrom('escalations')
      .select('id')
      .where('run_id', '=', job.runId)
      .execute();
    expect(escalations).toHaveLength(1);
  });

  it('fails the issue for a failed run, with the note as the reason', async () => {
    const { issue, job } = await fixing();
    const note = { summary: 'The sandbox container did not start.', tried: [], blocker: 'boom' };
    await runs.record(finished(job, { status: 'failed', note }));

    expect(await issues.get(issue.id)).toMatchObject({ status: 'failed', currentTier: 1 });
    expect((await issues.events(issue.id)).at(-1)?.event).toEqual({
      type: 'fail',
      runId: job.runId,
      reason: 'The sandbox container did not start. boom',
    });
    expect((await runRow(job.runId))?.status).toBe('failed');
  });

  it('kills the issue for a killed run', async () => {
    const { issue, job } = await fixing();
    await runs.record(finished(job, { status: 'killed', note: null }));
    expect((await issues.get(issue.id)).status).toBe('killed');
  });

  it('records the run of an issue a person already killed, and leaves the issue', async () => {
    const { issue, job } = await fixing();
    await issues.apply(issue.id, { type: 'kill' });
    expect(await runs.record(finished(job))).toEqual({ kind: 'stale' });
    expect((await issues.get(issue.id)).status).toBe('killed');
    expect((await runRow(job.runId))?.status).toBe('succeeded');
  });

  it('logs and drops a result for an issue that does not exist', async () => {
    const lines: unknown[] = [];
    const logger = createLogger('info', { write: (line: string) => lines.push(JSON.parse(line)) });
    const logged = new RunsService(deps.db, issues, logger);
    const { job } = await fixing();
    const orphan = finished({ ...job, issueId: randomUUID() });
    expect(await logged.record(orphan)).toEqual({ kind: 'no_issue' });
    expect(await runRow(job.runId)).toBeUndefined();
    expect(lines).toEqual([
      expect.objectContaining({ msg: 'run finished for an issue that does not exist' }),
    ]);
  });
});

describe('issueEventFor', () => {
  const runId = randomUUID();
  const base = { v: 1, runId, prUrl: null, confidence: null } as const;

  it('maps each outcome to its issue event', () => {
    expect(issueEventFor({ ...base, status: 'succeeded', note: null })).toEqual({
      type: 'patch_ready',
      runId,
    });
    expect(issueEventFor({ ...base, status: 'failed', note: null })).toEqual({
      type: 'fail',
      runId,
      reason: 'The run failed.',
    });
    expect(issueEventFor({ ...base, status: 'killed', note: null })).toEqual({ type: 'kill' });
  });

  it('keeps the reason within the event contract', () => {
    const note = { summary: 's', tried: [], blocker: 'x'.repeat(3000) };
    const event = issueEventFor({ ...base, status: 'failed', note });
    expect(event.type === 'fail' && event.reason.length).toBe(2000);
  });
});
