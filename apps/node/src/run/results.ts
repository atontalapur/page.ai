import { runFinishedJobSchema, type JobPayload, type QueueName } from '@page/contracts';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

/** The orchestrator's queue for finished runs. It creates the queue; the daemon sends. */
export const RUN_FINISHED_QUEUE = 'run_finished' satisfies QueueName;

export type RunFinishedJob = JobPayload<typeof RUN_FINISHED_QUEUE>;

/**
 * Where the daemon reports each finished run (#136). Unlike the socket's
 * `node.run.finished`, which is best effort, this is the record: the orchestrator writes the
 * `runs` row and moves the issue from it. PgBossRunResults sends it to the orchestrator's
 * pg-boss queue; FakeRunResults keeps it for tests.
 */
export interface RunResults {
  /** Resolves once the job is queued. Rejects if it can't be, and the run's job then fails. */
  send(job: RunFinishedJob): Promise<void>;
}

/** Parses before sending, so the daemon never queues what the orchestrator would reject. */
export function checkedResult(job: RunFinishedJob): RunFinishedJob {
  return runFinishedJobSchema.parse(job);
}

export interface PgBossRunResultsOptions {
  /** Started and stopped by the caller, which also owns its connection. */
  boss: PgBoss;
  logger: Logger;
  /** Tries per job, for a database that blips. */
  attempts?: number;
  /** Before the second try; doubled for each one after. */
  retryDelayMs?: number;
}

export class PgBossRunResults implements RunResults {
  private readonly boss: PgBoss;
  private readonly logger: Logger;
  private readonly attempts: number;
  private readonly retryDelayMs: number;

  constructor({ boss, logger, attempts = 3, retryDelayMs = 1000 }: PgBossRunResultsOptions) {
    this.boss = boss;
    this.logger = logger;
    this.attempts = attempts;
    this.retryDelayMs = retryDelayMs;
  }

  async send(job: RunFinishedJob): Promise<void> {
    const data = checkedResult(job);
    const { runId } = data.result;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.boss.send(RUN_FINISHED_QUEUE, data);
        return;
      } catch (error) {
        if (attempt >= this.attempts) {
          this.logger.error({ err: error, runId }, 'could not queue the run result');
          throw error;
        }
        this.logger.warn(
          { err: error, runId, attempt },
          'queueing the run result failed; retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
}

/** Records each result after checking it against the contract. */
export class FakeRunResults implements RunResults {
  readonly sent: RunFinishedJob[] = [];

  send(job: RunFinishedJob): Promise<void> {
    this.sent.push(checkedResult(job));
    return Promise.resolve();
  }
}
