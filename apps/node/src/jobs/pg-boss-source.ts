import type { Job, PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FIX_QUEUE, parseFixJob, type FixJobHandler, type JobSource } from './job-source.ts';

export interface PgBossJobSourceOptions {
  /** Started and stopped by the caller, which also owns its connection. */
  boss: PgBoss;
  logger: Logger;
  /** Runs this daemon works on at once. Each one is a container. */
  concurrency?: number;
}

/**
 * Claims fix jobs from the orchestrator's `fix` queue. The orchestrator creates the queue
 * with its singleton policy; this only works it, so the two never disagree on its options.
 */
export class PgBossJobSource implements JobSource {
  private readonly boss: PgBoss;
  private readonly logger: Logger;
  private readonly concurrency: number;

  constructor({ boss, logger, concurrency = 1 }: PgBossJobSourceOptions) {
    this.boss = boss;
    this.logger = logger;
    this.concurrency = concurrency;
  }

  async start(handler: FixJobHandler): Promise<void> {
    await this.boss.work(
      FIX_QUEUE,
      { batchSize: 1, localConcurrency: this.concurrency },
      fixJobWorker(handler, this.logger),
    );
  }

  async stop(): Promise<void> {
    await this.boss.offWork(FIX_QUEUE, { wait: true });
  }
}

/**
 * The pg-boss handler: parses each job and passes it on. A job that doesn't parse is
 * thrown back, so pg-boss marks it failed and it shows up there instead of vanishing.
 */
export function fixJobWorker(handler: FixJobHandler, logger: Logger) {
  return async (jobs: Job<unknown>[]): Promise<void> => {
    for (const { id, data, signal, retryCount } of jobs) {
      const parsed = parseFixJob(id, data);
      if (!parsed.ok) {
        logger.error({ jobId: id }, parsed.error);
        throw new Error(parsed.error);
      }
      const { issueId, runId, tier } = parsed.value;
      logger.info({ issueId, runId, tier, attempt: retryCount }, 'claimed fix job');
      await handler({ job: parsed.value, signal, attempt: retryCount });
    }
  };
}
