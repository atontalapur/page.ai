import { FIX_JOB_QUEUE, type FixJob } from '@page/contracts';
import type { Transaction } from 'kysely';
import { fromKysely, type PgBoss } from 'pg-boss';
import type { Database } from '../db/database.ts';

export interface FixJobQueue {
  /**
   * Queues a fix job inside `trx`, so the job exists only if the status change that
   * caused it commits. Returns the job id.
   */
  send(job: FixJob, trx: Transaction<Database>): Promise<string | null>;
}

/** Creates the queue if needed and returns a sender bound to it. */
export async function createFixJobQueue(boss: PgBoss): Promise<FixJobQueue> {
  await boss.createQueue(FIX_JOB_QUEUE);
  return {
    send: (job, trx) =>
      // No dedupe key needed: apply() holds the issue's row lock and tiers only go up,
      // so each tier of an issue is entered once.
      boss.send(FIX_JOB_QUEUE, job, { db: fromKysely(trx) }),
  };
}
