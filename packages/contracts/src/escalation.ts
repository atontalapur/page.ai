import { z } from 'zod';

/** What a run leaves behind when it escalates or fails. #10 puts it in the PR body. */
export const escalationNoteSchema = z.strictObject({
  summary: z.string().trim().min(1).max(500),
  // What the agent tried, in order.
  tried: z.array(z.string().trim().min(1)),
  // Why this tier could not finish the fix.
  blocker: z.string().trim().min(1),
});

export type EscalationNote = z.infer<typeof escalationNoteSchema>;
