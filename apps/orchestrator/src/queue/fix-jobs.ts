import { randomUUID } from 'node:crypto';
import {
  fixJobSchema,
  type EscalationNote,
  type JobPayload,
  type QueueName,
  type Tier,
} from '@page/contracts';
import type { Transaction } from 'kysely';
import { fromKysely, type PgBoss } from 'pg-boss';
import type { Database } from '../db/database.ts';

export const FIX_QUEUE = 'fix' satisfies QueueName;

export type FixJob = JobPayload<typeof FIX_QUEUE>;

/**
 * How long a claimed fix job may run before pg-boss expires it and the daemon stops the
 * sandbox. A run gets 14 minutes of agent wall clock (packages/agent threshold.ts) from the
 * moment its sandbox is up, on top of the sandbox start, the diff read and closing a PR.
 * pg-boss's 900 s default would expire a run that used its whole budget.
 */
export const FIX_EXPIRE_SECONDS = 20 * 60;

/** What a fix job is queued with. The queue adds `v` and the `runId`. */
export interface FixJobInput {
  issueId: string;
  fingerprint: string;
  tier: Tier;
  report: string;
  escalationNote?: EscalationNote;
}

export interface FixJobQueue {
  /**
   * Queues a fix job inside `trx`, so the job exists only if the status change that
   * caused it commits. Returns the job; its `runId` is also the pg-boss job id.
   */
  send(input: FixJobInput, trx: Transaction<Database>): Promise<FixJob | null>;

  /**
   * Cancels the job for `runId` inside `trx` if it is still queued, retrying or active, so
   * it is never claimed or retried. A job that already finished is left alone.
   */
  cancel(runId: string, trx: Transaction<Database>): Promise<void>;
}

/** Creates the queue if needed and returns a sender bound to it. */
export async function createFixJobQueue(boss: PgBoss): Promise<FixJobQueue> {
  // One created or active job per fingerprint (see `fingerprintSchema`). No retries:
  // a failure escalates. The run a new tier replaces is cancelled in the same transaction,
  // which frees the key so the next job can be queued.
  const options = { retryLimit: 0, expireInSeconds: FIX_EXPIRE_SECONDS };
  await boss.createQueue(FIX_QUEUE, { policy: 'exclusive', ...options });
  // createQueue leaves an existing queue as it was, so a deployed one gets the new expiry here.
  await boss.updateQueue(FIX_QUEUE, options);
  return {
    async send(input, trx) {
      // The node daemon reports the run under this id.
      const job = fixJobSchema.parse({ v: 1, runId: randomUUID(), ...input });
      const id = await boss.send(FIX_QUEUE, job, {
        id: job.runId,
        db: fromKysely(trx),
        singletonKey: job.fingerprint,
      });
      return id ? job : null;
    },
    async cancel(runId, trx) {
      await boss.cancel(FIX_QUEUE, runId, { db: fromKysely(trx) });
    },
  };
}
