import {
  fixJobSchema,
  notifyJobSchema,
  runFinishedJobSchema,
  triageJobSchema,
  type JobPayload,
} from '@page/contracts';
import type { PgBoss } from 'pg-boss';
import { FIX_FAILED_QUEUE } from './fix-jobs.ts';
import { NOTIFY_QUEUE, RUN_FINISHED_QUEUE, TRIAGE_QUEUE } from './queues.ts';

export interface NotifyAttempt {
  /** How many retries have already happened. The first try is 0. */
  retryCount: number;
  retryLimit: number;
}

/**
 * Claims triage, notify, run_finished and dead-lettered fix jobs, and parses each payload
 * before the handler sees it.
 */
export async function startWorkers(
  boss: PgBoss,
  handlers: {
    triage(job: JobPayload<'triage'>): Promise<void>;
    notify(job: JobPayload<'notify'>, attempt: NotifyAttempt): Promise<void>;
    runFinished(job: JobPayload<'run_finished'>): Promise<void>;
    /** A fix job pg-boss failed, and the error it kept for it (null if none). */
    fixFailed(job: JobPayload<'fix'>, output: unknown): Promise<void>;
  },
): Promise<void> {
  await boss.work(TRIAGE_QUEUE, async (jobs) => {
    for (const job of jobs) await handlers.triage(triageJobSchema.parse(job.data));
  });
  // One job per phone, so several workers ring the phones together rather than in turn.
  const notifyOptions = { includeMetadata: true, localConcurrency: 5 } as const;
  await boss.work(NOTIFY_QUEUE, notifyOptions, async (jobs) => {
    for (const job of jobs) {
      await handlers.notify(notifyJobSchema.parse(job.data), {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
    }
  });
  await boss.work(RUN_FINISHED_QUEUE, async (jobs) => {
    for (const job of jobs) await handlers.runFinished(runFinishedJobSchema.parse(job.data));
  });
  // A dead letter is a copy of the fix job; sourceOutput is what the fix job failed with.
  await boss.work(FIX_FAILED_QUEUE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      await handlers.fixFailed(fixJobSchema.parse(job.data), job.sourceOutput);
    }
  });
}
