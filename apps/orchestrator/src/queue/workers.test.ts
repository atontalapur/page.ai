import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { jobFixtures } from '@page/contracts/fixtures';
import { FIX_QUEUE } from './fix-jobs.ts';
import { NOTIFY_QUEUE, RUN_FINISHED_QUEUE, TRIAGE_QUEUE } from './queues.ts';
import { startWorkers } from './workers.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

const issueId = '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60';

describe('workers', () => {
  it('parses triage, notify, run_finished and dead-lettered jobs before the handler runs', async () => {
    const seen: string[] = [];
    // A result the handler can't record. With no retries left, pg-boss dead letters it.
    const run = jobFixtures.run_finished;
    const unrecordable = { ...run, result: { ...run.result, runId: randomUUID() } };
    await startWorkers(deps.boss, {
      triage: (job) => {
        seen.push(`triage:${job.issueId}`);
        return Promise.resolve();
      },
      notify: (job, attempt) => {
        seen.push(`notify:${job.channel}:${attempt.retryCount}`);
        return Promise.resolve();
      },
      runFinished: (job) => {
        if (job.result.runId === unrecordable.result.runId) {
          return Promise.reject(new Error('deadlock detected'));
        }
        seen.push(`run_finished:${job.result.status}`);
        return Promise.resolve();
      },
      fixFailed: (job, output) => {
        seen.push(`fix_failed:${job.tier}:${(output as { message?: string }).message}`);
        return Promise.resolve();
      },
      runFinishedFailed: (job, output) => {
        const { message } = output as { message?: string };
        seen.push(
          `run_finished_failed:${job.result.runId === unrecordable.result.runId}:${message}`,
        );
        return Promise.resolve();
      },
    });
    await deps.jobs.sendTriage(issueId, 'fp-worker');
    await deps.jobs.sendNotify(
      { v: 2, issueId, channel: 'sms', to: '+15550000001', message: 'page' },
      'fp-worker-sms',
    );
    await deps.boss.send(RUN_FINISHED_QUEUE, jobFixtures.run_finished);
    await deps.boss.send(RUN_FINISHED_QUEUE, unrecordable, { retryLimit: 0 });
    const fix = await deps.db
      .transaction()
      .execute((trx) =>
        deps.fixJobs.send({ issueId, fingerprint: 'fp-worker-fix', tier: 1, report: 'x' }, trx),
      );
    await deps.boss.fail(FIX_QUEUE, fix!.runId, new Error('daemon broke'));

    await expect
      .poll(() => seen.slice().sort(), { timeout: 8_000 })
      .toEqual([
        'fix_failed:1:daemon broke',
        `notify:sms:0`,
        'run_finished:succeeded',
        'run_finished_failed:true:deadlock detected',
        `triage:${issueId}`,
      ]);

    const triage = await deps.boss.findJobs(TRIAGE_QUEUE, { data: { issueId } });
    const notify = await deps.boss.findJobs(NOTIFY_QUEUE, { data: { issueId } });
    expect(triage.map((job) => job.state)).toEqual(['completed']);
    expect(notify.map((job) => job.state)).toEqual(['completed']);
  });
});
