import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { createFixJobQueue, FIX_EXPIRE_SECONDS, FIX_QUEUE, type FixJob } from './fix-jobs.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

const issueId = '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60';
const fingerprint = 'fp-queue';
const report = 'GET / (route /)\n\nRangeError: Invalid currency code : US';

describe('fix job queue', () => {
  it('can be created again on every boot', async () => {
    await expect(createFixJobQueue(deps.boss)).resolves.toBeDefined();
  });

  it('gives a claimed run longer than its agent budget before it expires', async () => {
    // As a queue created before the expiry was set: the next boot updates it.
    await deps.boss.updateQueue(FIX_QUEUE, { expireInSeconds: 900 });
    await createFixJobQueue(deps.boss);
    const queue = await deps.boss.getQueue(FIX_QUEUE);
    expect(queue?.expireInSeconds).toBe(FIX_EXPIRE_SECONDS);
    expect(FIX_EXPIRE_SECONDS).toBeGreaterThan(14 * 60 + 60);
  });

  it('sends nothing when the transaction rolls back', async () => {
    await expect(
      deps.db.transaction().execute(async (trx) => {
        await deps.fixJobs.send({ issueId, fingerprint, tier: 2, report }, trx);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await deps.boss.findJobs(FIX_QUEUE, { data: { issueId, tier: 2 } })).toEqual([]);
  });

  it('queues a job that matches the shared contract when the transaction commits', async () => {
    const sent = await deps.db
      .transaction()
      .execute((trx) => deps.fixJobs.send({ issueId, fingerprint, tier: 1, report }, trx));
    expect(sent).toMatchObject({ v: 1, issueId, fingerprint, tier: 1, report });

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
        .execute((trx) => deps.fixJobs.send({ issueId, fingerprint, tier: 1, report }, trx));
      if (job) sent.push(job);
    }
    expect(sent).toHaveLength(1);
    const jobs = await deps.boss.findJobs<FixJob>(FIX_QUEUE, { data: { fingerprint } });
    expect(jobs.filter((job) => job.state !== 'cancelled')).toHaveLength(1);
  });
});
