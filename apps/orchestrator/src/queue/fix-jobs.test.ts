import { FIX_JOB_QUEUE } from '@page/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { createFixJobQueue } from './fix-jobs.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

const issueId = '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60';

describe('fix job queue', () => {
  it('can be created again on every boot', async () => {
    await expect(createFixJobQueue(deps.boss)).resolves.toBeDefined();
  });

  it('sends nothing when the transaction rolls back', async () => {
    await expect(
      deps.db.transaction().execute(async (trx) => {
        await deps.fixJobs.send({ issueId, tier: 2 }, trx);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await deps.boss.findJobs(FIX_JOB_QUEUE, { data: { issueId, tier: 2 } })).toEqual([]);
  });

  it('queues a job when the transaction commits', async () => {
    const id = await deps.db
      .transaction()
      .execute((trx) => deps.fixJobs.send({ issueId, tier: 1 }, trx));
    const jobs = await deps.boss.findJobs(FIX_JOB_QUEUE, { data: { issueId, tier: 1 } });
    expect(jobs.map((j) => j.id)).toEqual([id]);
  });
});
