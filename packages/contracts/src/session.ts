import { z } from 'zod';
import { approverNameSchema } from './db.ts';

/**
 * Who the orchestrator takes a caller to be, from the token it sent (`GET /me`).
 *
 * - `personal`: a personal dashboard token (DASHBOARD_TOKENS), which names one person. Their
 *   Tier 3 decisions and issue events are recorded under that name.
 * - `shared`: the shared ORCHESTRATOR_API_TOKEN, which names no one. With no personal tokens
 *   configured it can decide, under a name the tab gives (`canDecide`). Once they are, it can
 *   still read and send issue events, but it can't decide.
 */
export const sessionSchema = z.discriminatedUnion('token', [
  z.strictObject({ token: z.literal('personal'), name: approverNameSchema }),
  z.strictObject({ token: z.literal('shared'), canDecide: z.boolean() }),
]);

export type Session = z.infer<typeof sessionSchema>;
