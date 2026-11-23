import { nodeFixQueue } from '@page/contracts';
import type { Job, PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { FIX_QUEUE, parseFixJob, type FixJobHandler, type JobSource } from './job-source.ts';

// How long the daemon waits before asking again when neither queue has a job.
const POLL_MS = 2_000;

export interface PgBossJobSourceOptions {
  /** Started and stopped by the caller, which also owns its connection. */
  boss: PgBoss;
  logger: Logger;
  /** This daemon's name: it also claims the fixes started on it by name. */
  name: string;
  /** How long to wait between empty polls. Tests make it short. */
  pollMs?: number;
}

/**
 * Claims fix jobs one at a time: first from this agent's own queue (the fixes a person
 * started on it by name), then from the shared `fix` queue. One loop over both, rather than
 * a pg-boss worker per queue, so the daemon never holds two runs at once; a host with one
 * sandbox depends on that. The orchestrator creates the queues with their options; this
 * only works them, so the two never disagree.
 */
export class PgBossJobSource implements JobSource {
  private readonly boss: PgBoss;
  private readonly logger: Logger;
  private readonly queues: string[];
  private readonly pollMs: number;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private warned = new Set<string>();

  constructor({ boss, logger, name, pollMs = POLL_MS }: PgBossJobSourceOptions) {
    this.boss = boss;
    this.logger = logger;
    this.queues = [nodeFixQueue(name), FIX_QUEUE];
    this.pollMs = pollMs;
  }

  start(handler: FixJobHandler): Promise<void> {
    this.stopping = false;
    this.loop = this.run(handler);
    return Promise.resolve();
  }

  /** Stops claiming and waits for the job in hand, if any, to finish. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  private async run(handler: FixJobHandler): Promise<void> {
    const work = fixJobWorker(handler, this.logger);
    while (!this.stopping) {
      const claimed = await this.claimOne();
      if (!claimed) {
        await this.pause();
        continue;
      }
      const { queue, job } = claimed;
      // The queue expires a job it has given up on; the run stops at the same moment.
      const expired = new AbortController();
      const timer = setTimeout(
        () => expired.abort(new Error('the fix job expired')),
        job.expireInSeconds * 1000,
      );
      try {
        await work([{ ...job, signal: expired.signal }]);
        await this.boss.complete(queue, job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.boss.fail(queue, job.id, { message }).catch((failError: unknown) => {
          this.logger.error({ err: failError, jobId: job.id }, 'could not fail the fix job');
        });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** The next job from this agent's queue, else the shared one. */
  private async claimOne(): Promise<{ queue: string; job: Job<unknown> } | undefined> {
    for (const queue of this.queues) {
      try {
        const [job] = await this.boss.fetch<unknown>(queue, { batchSize: 1 });
        if (job) return { queue, job };
      } catch (error) {
        // An agent's own queue exists only once a fix has been started on it by name.
        if (queue !== FIX_QUEUE && /does not exist/i.test(String(error))) continue;
        if (!this.warned.has(queue)) {
          this.warned.add(queue);
          this.logger.warn({ err: error, queue }, 'could not claim from the queue; retrying');
        }
      }
    }
    return undefined;
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.pollMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}

/**
 * Parses each job and passes it on. A job that doesn't parse is thrown back, so pg-boss marks
 * it failed and it shows up there instead of vanishing.
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
