import { notifyJobSchema, triageJobSchema, type JobPayload } from '@page/contracts';
import type { PgBoss } from 'pg-boss';
import { NOTIFY_QUEUE, TRIAGE_QUEUE } from './queues.ts';

export interface NotifyAttempt {
  /** How many retries have already happened. The first try is 0. */
  retryCount: number;
  retryLimit: number;
}

/** Claims triage and notify jobs and parses each payload before the handler sees it. */
export async function startWorkers(
  boss: PgBoss,
  handlers: {
    triage(job: JobPayload<'triage'>): Promise<void>;
    notify(job: JobPayload<'notify'>, attempt: NotifyAttempt): Promise<void>;
  },
): Promise<void> {
  await boss.work(TRIAGE_QUEUE, async (jobs) => {
    for (const job of jobs) await handlers.triage(triageJobSchema.parse(job.data));
  });
  await boss.work(NOTIFY_QUEUE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      await handlers.notify(notifyJobSchema.parse(job.data), {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
    }
  });
}
