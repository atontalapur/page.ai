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
