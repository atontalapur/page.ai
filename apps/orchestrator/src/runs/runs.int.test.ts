import { fixJobSchema, type JobPayload } from '@page/contracts';
import { escalationNoteFixture } from '@page/contracts/fixtures';
import { afterAll, describe, expect, it } from 'vitest';
import { createSchemaDeps } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { FIX_QUEUE } from '../queue/fix-jobs.ts';
import { RUN_FINISHED_QUEUE } from '../queue/queues.ts';
import { startWorkers } from '../queue/workers.ts';
import { TriageClassifier } from '../triage/classify.ts';
import { TriageService } from '../triage/triage.service.ts';
import { failureMessage, RunsService } from './runs.service.ts';

// The whole loop on real Postgres, with this test playing the node daemon: triage starts
// the fix, the daemon claims it from pg-boss and sends its result as a run_finished job, and
// the worker records it.

const deps = await createSchemaDeps();
afterAll(() => deps.close());

const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger);
const runs = new RunsService(deps.db, issues, deps.jobs, deps.logger);
const config = { ...deps.config, autoStartFix: true };
const triage = new TriageService(
  issues,
  deps.jobs,
  new TriageClassifier(null, 1000),
  config,
  deps.logger,
);
await startWorkers(deps.boss, {
  triage: (job) => triage.handle(job),
  notify: () => Promise.resolve(),
  runFinished: async (job) => {
    await runs.record(job);
  },
  fixFailed: async (job, output) => {
    await runs.recordLost(job, failureMessage(output));
  },
});

const report = 'GET /\n\nRangeError: Invalid currency code : US';

/** Claims the next fix job the way apps/node does and reads it through the contract. */
async function claim() {
  let claimed: JobPayload<'fix'> | undefined;
  await expect
    .poll(
      async () => {
        const [job] = await deps.boss.fetch(FIX_QUEUE);
        if (job) claimed = fixJobSchema.parse(job.data);
        return claimed;
      },
      { timeout: 10_000 },
    )
    .toBeDefined();
  return claimed!;
}

function finished(job: JobPayload<'fix'>, result: Record<string, unknown>) {
  return {
    v: 1,
    issueId: job.issueId,
    tier: job.tier,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    diff: null,
    result: { v: 1, runId: job.runId, prUrl: null, confidence: null, ...result },
  };
}

describe('fix runs on real Postgres', () => {
  // Several jobs pass through pg-boss workers that poll every couple of seconds.
  it('starts, escalates and finishes a fix from the run_finished queue', async () => {
    const { issue } = await issues.report(
      { fingerprint: 'int-runs', title: 'RangeError: Invalid currency code : US' },
      report,
    );
    await deps.jobs.sendTriage(issue.id, 'int-runs');

    const tier1 = await claim();
    expect(tier1).toMatchObject({ issueId: issue.id, tier: 1, report });

    await deps.boss.send(
      RUN_FINISHED_QUEUE,
      finished(tier1, {
        status: 'escalated',
        reason: 'budget_exhausted',
        toTier: 2,
        note: escalationNoteFixture,
      }),
    );
    const tier2 = await claim();
    expect(tier2).toMatchObject({ tier: 2, report, escalationNote: escalationNoteFixture });

    const diff = '--- a/src/shop/money.ts\n+++ b/src/shop/money.ts\n';
    await deps.boss.send(RUN_FINISHED_QUEUE, {
      ...finished(tier2, { status: 'succeeded', note: null }),
      diff,
    });
    await expect
      .poll(async () => (await issues.get(issue.id)).status, { timeout: 10_000 })
      .toBe('awaiting_approval');

    const rows = await deps.db
      .selectFrom('runs')
      .select(['id', 'tier', 'status', 'diff'])
      .where('issue_id', '=', issue.id)
      .orderBy('tier')
      .execute();
    expect(rows).toEqual([
      { id: tier1.runId, tier: 1, status: 'escalated', diff: null },
      { id: tier2.runId, tier: 2, status: 'succeeded', diff },
    ]);
    expect(await issues.get(issue.id)).toMatchObject({ currentTier: 2 });
  }, 40_000);

  it('fails the issue when the fix job fails with no result', async () => {
    const { issue } = await issues.report({ fingerprint: 'int-lost', title: 'Boom' }, report);
    await deps.jobs.sendTriage(issue.id, 'int-lost');
    const tier1 = await claim();

    // What pg-boss does when the daemon throws before it queues a result, or the job expires.
    await deps.boss.fail(FIX_QUEUE, tier1.runId, new Error('could not queue the run result'));
    await expect
      .poll(async () => (await issues.get(issue.id)).status, { timeout: 10_000 })
      .toBe('failed');

    const row = await deps.db
      .selectFrom('runs')
      .select(['tier', 'status'])
      .where('id', '=', tier1.runId)
      .executeTakeFirst();
    expect(row).toEqual({ tier: 1, status: 'failed' });
    expect((await issues.events(issue.id)).at(-1)?.event).toMatchObject({
      type: 'fail',
      runId: tier1.runId,
    });
  }, 30_000);
});
