import { afterAll, describe, expect, it } from 'vitest';
import { createSchemaDeps } from '../db/test-utils.ts';
import { FIX_QUEUE, type FixJob } from './fix-jobs.ts';

const deps = await createSchemaDeps();
afterAll(() => deps.close());

describe('fix job queue on real Postgres', () => {
  it('creates one fix job when ten are sent for the same fingerprint', async () => {
    const issueId = '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60';
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
