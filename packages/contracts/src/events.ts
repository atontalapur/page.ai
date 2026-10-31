import { z } from 'zod';
import { idSchema } from './common.ts';
import { approvalSchema, issueSchema, RUN_STATUSES, runSchema, stepSchema } from './db.ts';
import { escalationNoteSchema } from './escalation.ts';

// Socket.IO events, one map per direction. Every payload carries a literal `v`; a breaking
// change bumps it, and a receiver rejects a `v` it does not know.

const v = z.literal(1);

const runKill = z.strictObject({ v, runId: idSchema });
const runChat = z.strictObject({ v, runId: idSchema, message: z.string().min(1) });
const runDiff = z.strictObject({ v, runId: idSchema, diff: z.string() });

export const serverToUiEvents = {
  'issue.updated': z.strictObject({ v, issue: issueSchema }),
  'run.started': z.strictObject({ v, run: runSchema }),
  'run.step': z.strictObject({ v, step: stepSchema }),
  'run.diff': runDiff,
  'run.finished': z.strictObject({ v, run: runSchema, note: escalationNoteSchema.nullable() }),
  'approval.requested': z.strictObject({ v, approval: approvalSchema }),
};

export const uiToServerEvents = {
  'run.kill': runKill,
  'run.chat': runChat,
  'approval.decide': z.strictObject({
    v,
    approvalId: idSchema,
    decision: z.enum(['approved', 'rejected']),
    decidedBy: z.string().min(1),
  }),
};

/**
 * The node daemon streams over its outbound socket (#8). The server stores each step and
 * relays it to the UI as `run.step`.
 */
export const nodeToServerEvents = {
  'node.step': z.strictObject({ v, step: stepSchema }),
  'node.diff': runDiff,
  'node.run.finished': z.strictObject({
    v,
    runId: idSchema,
    status: z.enum(RUN_STATUSES).exclude(['queued', 'running']),
    prUrl: z.url().nullable(),
    note: escalationNoteSchema.nullable(),
  }),
};

/** UI requests the server relays to the node running the run (#9). */
export const serverToNodeEvents = {
  'run.kill': runKill,
  'run.chat': runChat,
};

type Handlers<T extends Record<string, z.ZodType>> = {
  [K in keyof T]: (payload: z.infer<T[K]>) => void;
};

// Event maps in the shape Socket.IO's `Server<Listen, Emit>` and `Socket<Listen, Emit>` take.
export type ServerToUiEvents = Handlers<typeof serverToUiEvents>;
export type UiToServerEvents = Handlers<typeof uiToServerEvents>;
export type NodeToServerEvents = Handlers<typeof nodeToServerEvents>;
export type ServerToNodeEvents = Handlers<typeof serverToNodeEvents>;
