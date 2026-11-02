import { z } from 'zod';
import { idSchema, prUrlSchema, tierSchema } from './common.ts';
import {
  APPROVAL_DECISIONS,
  approvalSchema,
  confidenceSchema,
  decidedApprovalSchema,
  ESCALATION_REASONS,
  issueSchema,
  pendingApprovalSchema,
  runSchema,
  stepSchema,
} from './db.ts';
import { escalationNoteSchema } from './escalation.ts';

// Socket.IO events, one map per direction. Every payload carries a literal `v`; a breaking
// change bumps it, and a receiver rejects a `v` it does not know.

const v = z.literal(1);

const runKill = z.strictObject({ v, runId: idSchema });
const runChat = z.strictObject({ v, runId: idSchema, message: z.string().min(1) });
const runDiff = z.strictObject({ v, runId: idSchema, diff: z.string() });

const runFinishedBase = {
  v,
  runId: idSchema,
  prUrl: prUrlSchema.nullable(),
  confidence: confidenceSchema.nullable(),
};

/**
 * The node's last word on a run. An escalation carries everything the server needs to write
 * the `Escalation` row; the server checks `toTier` is above the run's tier.
 */
const nodeRunFinished = z.discriminatedUnion('status', [
  z.strictObject({
    ...runFinishedBase,
    status: z.literal('succeeded'),
    confidence: confidenceSchema,
    note: escalationNoteSchema.nullable(),
  }),
  z.strictObject({
    ...runFinishedBase,
    status: z.literal('escalated'),
    reason: z.enum(ESCALATION_REASONS),
    toTier: tierSchema,
    note: escalationNoteSchema,
  }),
  z.strictObject({
    ...runFinishedBase,
    status: z.enum(['failed', 'killed']),
    note: escalationNoteSchema.nullable(),
  }),
]);

export const serverToUiEvents = {
  'issue.updated': z.strictObject({ v, issue: issueSchema }),
  'run.started': z.strictObject({ v, run: runSchema }),
  'run.step': z.strictObject({ v, step: stepSchema }),
  'run.diff': runDiff,
  'run.finished': z.strictObject({ v, run: runSchema, note: escalationNoteSchema.nullable() }),
  'approval.requested': z.strictObject({ v, approval: approvalSchema }),
  // Sent to every tab once an approval is decided, so none keeps showing it as pending.
  'approval.updated': z.strictObject({ v, approval: decidedApprovalSchema }),
};

export const uiToServerEvents = {
  'run.kill': runKill,
  'run.chat': runChat,
  // No `decidedBy`: the server takes it from the socket's identity, so a client can't
  // record a decision under someone else's name.
  'approval.decide': z.strictObject({
    v,
    approvalId: idSchema,
    decision: z.enum(APPROVAL_DECISIONS),
  }),
};

/**
 * The node daemon streams over its outbound socket (#8). The server stores each step and
 * relays it to the UI as `run.step`.
 */
export const nodeToServerEvents = {
  'node.step': z.strictObject({ v, step: stepSchema }),
  'node.diff': runDiff,
  'node.run.finished': nodeRunFinished,
  // A Tier 3 agent asks to run a gated host tool such as `ops.restart`. The node picks the
  // approval id so it can match the `approval.decided` that answers it.
  'node.approval.request': z.strictObject({
    v,
    approvalId: idSchema,
    runId: idSchema,
    action: pendingApprovalSchema.shape.action,
    args: pendingApprovalSchema.shape.args,
  }),
};

/** UI requests the server relays to the node running the run (#9), and approval outcomes. */
export const serverToNodeEvents = {
  'run.kill': runKill,
  'run.chat': runChat,
  'approval.decided': z.strictObject({ v, approval: decidedApprovalSchema }),
};

type Handlers<T extends Record<string, z.ZodType>> = {
  [K in keyof T]: (payload: z.infer<T[K]>) => void;
};

// Event maps in the shape Socket.IO's `Server<Listen, Emit>` and `Socket<Listen, Emit>` take.
export type ServerToUiEvents = Handlers<typeof serverToUiEvents>;
export type UiToServerEvents = Handlers<typeof uiToServerEvents>;
export type NodeToServerEvents = Handlers<typeof nodeToServerEvents>;
export type ServerToNodeEvents = Handlers<typeof serverToNodeEvents>;
