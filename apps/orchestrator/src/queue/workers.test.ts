import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { NOTIFY_QUEUE, TRIAGE_QUEUE } from './queues.ts';
import { startWorkers } from './workers.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

const issueId = '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60';

describe('workers', () => {
  it('parses a triage job and a notify job before the handler runs', async () => {
    const seen: string[] = [];
    await startWorkers(deps.boss, {
      triage: (job) => {
        seen.push(`triage:${job.issueId}`);
        return Promise.resolve();
      },
      notify: (job, attempt) => {
        seen.push(`notify:${job.channel}:${attempt.retryCount}`);
        return Promise.resolve();
      },
    });
    await deps.jobs.sendTriage(issueId, 'fp-worker');
    await deps.jobs.sendNotify({ v: 1, issueId, channel: 'sms', message: 'page' }, 'fp-worker-sms');

    await expect
      .poll(() => seen.slice().sort(), { timeout: 8_000 })
      .toEqual([`notify:sms:0`, `triage:${issueId}`]);

    const triage = await deps.boss.findJobs(TRIAGE_QUEUE, { data: { issueId } });
    const notify = await deps.boss.findJobs(NOTIFY_QUEUE, { data: { issueId } });
    expect(triage.map((job) => job.state)).toEqual(['completed']);
    expect(notify.map((job) => job.state)).toEqual(['completed']);
  });
});
