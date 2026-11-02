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
   * caused it commits. Returns the job.
   */
  send(
    issue: { issueId: string; fingerprint: string; tier: Tier },
    trx: Transaction<Database>,
  ): Promise<FixJob>;
}

/** Creates the queue if needed and returns a sender bound to it. */
export async function createFixJobQueue(boss: PgBoss): Promise<FixJobQueue> {
  // One active job per fingerprint (see `fingerprintSchema`): an escalation waits until
  // the run before it finishes.
  await boss.createQueue(FIX_QUEUE, { policy: 'singleton' });
  return {
    async send(issue, trx) {
      // The node daemon reports the run under this id.
      const job = fixJobSchema.parse({ v: 1, runId: randomUUID(), ...issue });
      await boss.send(FIX_QUEUE, job, { db: fromKysely(trx), singletonKey: job.fingerprint });
      return job;
    },
  };
}
