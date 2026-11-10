import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { createFixJobQueue, FIX_QUEUE, type FixJob } from './fix-jobs.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

const issueId = '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60';
const fingerprint = 'fp-queue';

describe('fix job queue', () => {
  it('can be created again on every boot', async () => {
    await expect(createFixJobQueue(deps.boss)).resolves.toBeDefined();
  });

  it('sends nothing when the transaction rolls back', async () => {
    await expect(
      deps.db.transaction().execute(async (trx) => {
        await deps.fixJobs.send({ issueId, fingerprint, tier: 2 }, trx);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await deps.boss.findJobs(FIX_QUEUE, { data: { issueId, tier: 2 } })).toEqual([]);
  });

  it('queues a job that matches the shared contract when the transaction commits', async () => {
    const sent = await deps.db
      .transaction()
      .execute((trx) => deps.fixJobs.send({ issueId, fingerprint, tier: 1 }, trx));
    expect(sent).toMatchObject({ v: 1, issueId, fingerprint, tier: 1 });

    const jobs = await deps.boss.findJobs<FixJob>(FIX_QUEUE, { data: { issueId, tier: 1 } });
    expect(jobs.map((j) => j.data)).toEqual([sent]);
    expect(jobs[0]?.singletonKey).toBe(fingerprint);
  });

  it('creates one fix job when ten are sent for the same fingerprint', async () => {
    const fingerprint = 'fp-ten';
    const sent = [];
    for (let i = 0; i < 10; i++) {
      const job = await deps.db
        .transaction()
        .execute((trx) => deps.fixJobs.send({ issueId, fingerprint, tier: 1 }, trx));
      if (job) sent.push(job);
    }
    expect(sent).toHaveLength(1);
    const jobs = await deps.boss.findJobs<FixJob>(FIX_QUEUE, { data: { fingerprint } });
    expect(jobs.filter((job) => job.state !== 'cancelled')).toHaveLength(1);
  });
});
