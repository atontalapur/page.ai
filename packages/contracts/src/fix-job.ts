import { z } from 'zod';
import { tier } from './issue.ts';

/** pg-boss queue the orchestrator sends fix jobs to and node daemons claim them from. */
export const FIX_JOB_QUEUE = 'fix-jobs';

export const fixJob = z.object({
  issueId: z.uuid(),
  tier,
});
export type FixJob = z.infer<typeof fixJob>;
