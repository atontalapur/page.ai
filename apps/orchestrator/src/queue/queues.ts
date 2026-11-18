import { notifyJobSchema, triageJobSchema, type JobPayload, type QueueName } from '@page/contracts';
import type { Transaction } from 'kysely';
import { fromKysely, type PgBoss } from 'pg-boss';
import type { Database } from '../db/database.ts';

export const TRIAGE_QUEUE = 'triage' satisfies QueueName;
export const NOTIFY_QUEUE = 'notify' satisfies QueueName;
/** The node daemon sends one job here per finished fix run; RunsService records it. */
export const RUN_FINISHED_QUEUE = 'run_finished' satisfies QueueName;

/** 3 tries with exponential backoff, for triage and for the call before SMS. */
const RETRIES = { retryLimit: 3, retryDelay: 2, retryBackoff: true } as const;

export interface JobQueues {
  /** Queues triage for a new issue. A second send for the fingerprint returns null. */
  sendTriage(
    issueId: string,
    fingerprint: string,
    trx?: Transaction<Database>,
  ): Promise<string | null>;
  /** Queues one phone's page. A second send for the fingerprint and phone returns null. */
  sendNotify(
    job: JobPayload<'notify'>,
    fingerprint: string,
    trx?: Transaction<Database>,
  ): Promise<string | null>;
}

function dbOpt(trx?: Transaction<Database>) {
  return trx ? { db: fromKysely(trx) } : {};
}

/**
 * Creates the triage, notify and run_finished queues if needed and returns senders for the
 * first two. Only the node daemon sends run_finished jobs, so this creates the queue it sends
 * to, as it does `fix`.
 */
export async function createJobQueues(boss: PgBoss): Promise<JobQueues> {
  // exclusive + singletonKey: one created or active job per fingerprint, and for notify per
  // fingerprint and phone, so each phone retries on its own.
  await boss.createQueue(TRIAGE_QUEUE, { policy: 'exclusive', ...RETRIES });
  await boss.createQueue(NOTIFY_QUEUE, { policy: 'exclusive', ...RETRIES });
  // No singleton: a result must never be dropped as a duplicate. Recording one is idempotent.
  await boss.createQueue(RUN_FINISHED_QUEUE, { ...RETRIES });
  return {
    sendTriage(issueId, fingerprint, trx) {
      const data = triageJobSchema.parse({ v: 1, issueId });
      return boss.send(TRIAGE_QUEUE, data, { singletonKey: fingerprint, ...dbOpt(trx) });
    },
    sendNotify(job, fingerprint, trx) {
      const data = notifyJobSchema.parse(job);
      const singletonKey = `${fingerprint}:${data.to}`;
      return boss.send(NOTIFY_QUEUE, data, { singletonKey, ...dbOpt(trx) });
    },
  };
}
