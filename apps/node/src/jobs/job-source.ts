import { fixJobSchema, type JobPayload, type QueueName } from '@page/contracts';
import { err, ok, type Result } from '@page/toolkit';

export const FIX_QUEUE = 'fix' satisfies QueueName;

export type FixJob = JobPayload<typeof FIX_QUEUE>;

/** A fix job this daemon holds. */
export interface ClaimedJob {
  job: FixJob;
  /** Aborts when the queue gives up on the job (it expired) or the daemon shuts down. */
  signal: AbortSignal;
  /** 0 on the first attempt, then one more per retry. */
  attempt: number;
}

/**
 * Runs one claimed job. Resolving marks the job done; the run's outcome travels to the
 * orchestrator on its own, so a failed or escalated run still resolves. Rejecting means
 * the daemon broke, and the queue may retry the job.
 */
export type FixJobHandler = (claimed: ClaimedJob) => Promise<void>;

/**
 * Where the daemon claims fix jobs. PgBossJobSource claims them from the orchestrator's
 * pg-boss queue; FakeJobSource hands them over in tests.
 */
export interface JobSource {
  start(handler: FixJobHandler): Promise<void>;
  /** Stops claiming and waits for jobs in hand to finish. */
  stop(): Promise<void>;
}

/**
 * Reads a queued job through the shared contract. The orchestrator uses the run id as the
 * pg-boss job id, so a job whose two disagree didn't come from it.
 */
export function parseFixJob(id: string, data: unknown): Result<FixJob, string> {
  const parsed = fixJobSchema.safeParse(data);
  if (!parsed.success) return err(`job ${id} is not a fix job: ${parsed.error.message}`);
  if (parsed.data.runId !== id) {
    return err(`job ${id} carries runId ${parsed.data.runId}; they must match`);
  }
  return ok(parsed.data);
}
