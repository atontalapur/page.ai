import { randomUUID } from 'node:crypto';
import { fixJobSchema, type JobPayload, type QueueName, type Tier } from '@page/contracts';
import type { Transaction } from 'kysely';
import { fromKysely, type PgBoss } from 'pg-boss';
import type { Database } from '../db/database.ts';

export const FIX_QUEUE = 'fix' satisfies QueueName;

export type FixJob = JobPayload<typeof FIX_QUEUE>;

export interface FixJobQueue {
  /**
   * Queues a fix job inside `trx`, so the job exists only if the status change that
   * caused it commits. Returns the job; its `runId` is also the pg-boss job id.
   */
  send(
    issue: { issueId: string; fingerprint: string; tier: Tier },
    trx: Transaction<Database>,
  ): Promise<FixJob>;

  /**
   * Cancels the job for `runId` inside `trx` if it is still queued, retrying or active, so
   * it is never claimed or retried. A job that already finished is left alone.
   */
  cancel(runId: string, trx: Transaction<Database>): Promise<void>;
}

/** Creates the queue if needed and returns a sender bound to it. */
export async function createFixJobQueue(boss: PgBoss): Promise<FixJobQueue> {
  // One active job per fingerprint (see `fingerprintSchema`). The run a new tier replaces
  // is cancelled in the same transaction, so the new job is claimable straight away.
  await boss.createQueue(FIX_QUEUE, { policy: 'singleton' });
  return {
    async send(issue, trx) {
      // The node daemon reports the run under this id.
      const job = fixJobSchema.parse({ v: 1, runId: randomUUID(), ...issue });
      await boss.send(FIX_QUEUE, job, {
        id: job.runId,
        db: fromKysely(trx),
        singletonKey: job.fingerprint,
      });
      return job;
    },
    async cancel(runId, trx) {
      await boss.cancel(FIX_QUEUE, runId, { db: fromKysely(trx) });
    },
  };
}
