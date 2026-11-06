import { randomBytes, randomUUID } from 'node:crypto';
import { jobFixtures } from '@page/contracts/fixtures';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIX_QUEUE, type ClaimedJob } from './job-source.ts';
import { PgBossJobSource } from './pg-boss-source.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests');

// A throwaway pg-boss schema, so the test never touches a shared queue.
const schema = `pgboss_node_test_${randomBytes(4).toString('hex')}`;
const boss = new PgBoss({ connectionString: url, schema, supervise: false, schedule: false });
const errors: unknown[] = [];
boss.on('error', (error) => errors.push(error));
const source = new PgBossJobSource({ boss, logger: pino({ enabled: false }) });

beforeAll(async () => {
  await boss.start();
  // As the orchestrator creates it (apps/orchestrator/src/queue/fix-jobs.ts).
  await boss.createQueue(FIX_QUEUE, { policy: 'singleton' });
}, 20_000);

afterAll(async () => {
  await boss.stop({ graceful: false });
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
  expect(errors).toEqual([]);
});

/** Resolves with the next claimed job; `outcome` decides how the handler ends. */
function nextClaim(outcome: () => Promise<void>) {
  return new Promise<ClaimedJob>((resolve) => {
    void source.start(async (claimed) => {
      resolve(claimed);
      await outcome();
    });
  });
}

const stateOf = async (id: string) => (await boss.findJobs(FIX_QUEUE, { id }))[0]?.state;

async function settled(id: string) {
  for (let i = 0; i < 100; i++) {
    const state = await stateOf(id);
    if (state !== 'created' && state !== 'active' && state !== 'retry') return state;
    await new Promise((r) => setTimeout(r, 100));
  }
  return stateOf(id);
}

describe('PgBossJobSource on real Postgres', () => {
  it('claims a queued fix job and completes it when the handler resolves', async () => {
    const runId = randomUUID();
    const job = { ...jobFixtures.fix, runId, fingerprint: `fp-${runId}` };
    const claim = nextClaim(() => Promise.resolve());
    await boss.send(FIX_QUEUE, job, { id: runId, singletonKey: job.fingerprint });

    const claimed = await claim;
    expect(claimed.job).toEqual(job);
    expect(claimed.attempt).toBe(0);
    expect(await settled(runId)).toBe('completed');
    await source.stop();
  }, 20_000);

  it('fails a job the contract rejects', async () => {
    const runId = randomUUID();
    const handled: ClaimedJob[] = [];
    await source.start((claimed) => {
      handled.push(claimed);
      return Promise.resolve();
    });
    await boss.send(FIX_QUEUE, { v: 1, runId }, { id: runId, retryLimit: 0 });

    expect(await settled(runId)).toBe('failed');
    expect(handled).toEqual([]);
    await source.stop();
  }, 20_000);
});
