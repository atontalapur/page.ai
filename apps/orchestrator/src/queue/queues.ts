import { notifyJobSchema, triageJobSchema, type JobPayload, type QueueName } from '@page/contracts';
import type { Transaction } from 'kysely';
import { fromKysely, type PgBoss } from 'pg-boss';
import type { Database } from '../db/database.ts';

export const TRIAGE_QUEUE = 'triage' satisfies QueueName;
export const NOTIFY_QUEUE = 'notify' satisfies QueueName;

/** 3 tries with exponential backoff, for triage and for the call before SMS. */
const RETRIES = { retryLimit: 3, retryDelay: 2, retryBackoff: true } as const;

export interface JobQueues {
  /** Queues triage for a new issue. A second send for the fingerprint returns null. */
  sendTriage(
    issueId: string,
    fingerprint: string,
    trx?: Transaction<Database>,
  ): Promise<string | null>;
  /** Queues the on-call page. A second send for the fingerprint returns null. */
  sendNotify(
    job: JobPayload<'notify'>,
    fingerprint: string,
    trx?: Transaction<Database>,
  ): Promise<string | null>;
}

function dbOpt(trx?: Transaction<Database>) {
  return trx ? { db: fromKysely(trx) } : {};
}

/** Creates the triage and notify queues if needed and returns senders bound to them. */
export async function createJobQueues(boss: PgBoss): Promise<JobQueues> {
  // exclusive + singletonKey: one created or active job per fingerprint.
  await boss.createQueue(TRIAGE_QUEUE, { policy: 'exclusive', ...RETRIES });
  await boss.createQueue(NOTIFY_QUEUE, { policy: 'exclusive', ...RETRIES });
  return {
    sendTriage(issueId, fingerprint, trx) {
      const data = triageJobSchema.parse({ v: 1, issueId });
      return boss.send(TRIAGE_QUEUE, data, { singletonKey: fingerprint, ...dbOpt(trx) });
    },
    sendNotify(job, fingerprint, trx) {
      const data = notifyJobSchema.parse(job);
      return boss.send(NOTIFY_QUEUE, data, { singletonKey: fingerprint, ...dbOpt(trx) });
    },
  };
}
