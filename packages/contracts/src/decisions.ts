import { z } from 'zod';

/** What jev decided about an issue: its triage, where its fix started, or an escalation. */
export const issueDecisionSchema = z.strictObject({
  id: z.string(),
  issueId: z.string(),
  runId: z.string().nullable(),
  question: z.enum(['triage', 'start_tier', 'escalation']),
  model: z.string(),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
  costUsd: z.number(),
  createdAt: z.string(),
});
export type IssueDecision = z.infer<typeof issueDecisionSchema>;

/** Model spend over every session: the agents' runs and jev's decisions. */
export const spendStatsSchema = z.strictObject({
  totalUsd: z.number(),
  runsUsd: z.number(),
  decisionsUsd: z.number(),
  runs: z.int(),
  decisions: z.int(),
});
export type SpendStats = z.infer<typeof spendStatsSchema>;
