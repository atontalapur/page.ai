import { z } from 'zod';
import { idSchema, prUrlSchema, tierSchema } from './common.ts';
import {
  APPROVAL_DECISIONS,
  approvalSchema,
  CHAT_CLOSE_REASONS,
  closedChatSchema,
  confidenceSchema,
  decidedApprovalSchema,
  type DecidedApproval,
  ESCALATION_REASONS,
  issueSchema,
  MAX_CHAT_ANSWER_CHARS,
  MAX_CHAT_CHARS,
  pendingApprovalSchema,
  pendingChatSchema,
  runSchema,
  stepSchema,
} from './db.ts';
import { escalationNoteSchema } from './escalation.ts';
import { nodeSummarySchema } from './nodes.ts';

// Socket.IO events, one map per direction. Every payload carries a literal `v`; a breaking
// change bumps it, and a receiver rejects a `v` it does not know.

const v = z.literal(1);

/** The Socket.IO namespace the orchestrator serves the UI on. */
export const UI_NAMESPACE = '/ui';

/** The Socket.IO namespace the orchestrator serves node daemons on. */
export const NODE_NAMESPACE = '/node';

/**
 * The `connect_error` messages a namespace sends when it turns a handshake away: a missing or
 * wrong token, or too many handshakes from one address. Socket.IO doesn't retry either, so
 * the client decides: ask for a token, or wait and connect again.
 */
export const SOCKET_REFUSALS = ['unauthorized', 'rate_limited'] as const;

export type SocketRefusal = (typeof SOCKET_REFUSALS)[number];

/**
 * The longest the server holds an approval request open, from when it hears it. A Tier 3
 * run's wall clock is 14 minutes, so no daemon waits longer; a later `expiresAt` is cut down
 * to this.
 */
export const MAX_APPROVAL_WAIT_MS = 15 * 60 * 1000;

/**
 * Why the server turned a tab's `run.chat` away. Only that tab hears it, as
 * `run.chat.refused`, and nothing is stored:
 * - `no_name`: the tab has no identity to record the message under, as for a Tier 3
 *   decision: no personal token and no name, or the shared token once personal tokens are
 *   configured.
 * - `rate_limited`: the tab sent messages faster than the chat limit allows.
 * - `not_in_progress`: the run is not its issue's run in progress.
 * - `no_daemon`: no connected daemon holds the run, so nothing would read the message.
 * - `too_many`: the run has had as many messages as one run takes.
 */
export const CHAT_REFUSALS = [
  'no_name',
  'rate_limited',
  'not_in_progress',
  'no_daemon',
  'too_many',
] as const;

export type ChatRefusal = (typeof CHAT_REFUSALS)[number];

const runKill = z.strictObject({ v, runId: idSchema });
const chatMessage = z.string().trim().min(1).max(MAX_CHAT_CHARS);
// A person's message to the agent on a run in progress. Who sent it comes from the socket.
const runChat = z.strictObject({ v, runId: idSchema, message: chatMessage });
const chatIds = { v, chatId: idSchema, runId: idSchema };
const runDiff = z.strictObject({ v, runId: idSchema, diff: z.string() });

const runFinishedBase = {
  v,
  runId: idSchema,
  prUrl: prUrlSchema.nullable(),
  confidence: confidenceSchema.nullable(),
  // What the run spent on the model, in US dollars. A daemon from before it was kept sends
  // none, and the run counts as $0.
  costUsd: z.number().min(0).optional(),
};

/**
 * The node's last word on a run. An escalation carries everything the server needs to write
 * the `Escalation` row; the server checks `toTier` is above the run's tier. The daemon sends
 * it on the socket for the UI and inside a `run_finished` job (jobs.ts) for the record.
 *
 * `confidence` is the daemon's score for a run whose agent submitted. It is null when the
 * run was not scored: a daemon from before scoring, or a score that couldn't be worked out.
 * A run with no score never escalates for want of one.
 */
export const nodeRunFinishedSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...runFinishedBase,
    status: z.literal('succeeded'),
    note: escalationNoteSchema.nullable(),
    // True when a Tier 3 run changed the live app through the ops API and left no code
    // change: no PR, and a workspace that matches the baseline. The fix is then live already
    // and there is nothing to approve. False whenever the daemon can't tell, so a diff it
    // couldn't read or that is over the cap still goes to review. A daemon from before the
    // field sends none, which reads as false.
    opsOnly: z.boolean().default(false),
  }),
  z
    .strictObject({
      ...runFinishedBase,
      status: z.literal('escalated'),
      reason: z.enum(ESCALATION_REASONS),
      toTier: tierSchema,
      note: escalationNoteSchema,
    })
    // A low score is the reason, so the score has to be there.
    .refine((e) => e.reason !== 'low_confidence' || e.confidence !== null, {
      path: ['confidence'],
      message: 'a low_confidence escalation carries its score',
    }),
  z.strictObject({
    ...runFinishedBase,
    status: z.enum(['failed', 'killed']),
    note: escalationNoteSchema.nullable(),
  }),
]);

/**
 * A piece of a run as it happens, for the live view: the model's reply or reasoning as it
 * is written, or a command's output as it prints. `seq` is the step it leads up to; the
 * finished step replaces it. Never stored.
 */
const runLiveSchema = z.strictObject({
  v,
  runId: idSchema,
  seq: z.int().min(0),
  kind: z.enum(['thinking', 'reasoning', 'output']),
  text: z.string().max(20_000),
});

export const serverToUiEvents = {
  'run.live': runLiveSchema,
  'issue.updated': z.strictObject({ v, issue: issueSchema }),
  'run.started': z.strictObject({ v, run: runSchema }),
  'run.step': z.strictObject({ v, step: stepSchema }),
  'run.diff': runDiff,
  'run.finished': z.strictObject({ v, run: runSchema, note: escalationNoteSchema.nullable() }),
  'approval.requested': z.strictObject({ v, approval: approvalSchema }),
  // Sent to every tab once an approval is decided, so none keeps showing it as pending.
  'approval.updated': z.strictObject({ v, approval: decidedApprovalSchema }),
  // A node daemon connected, disconnected, took a run or let one go. Carries the daemon as
  // GET /nodes lists it, so a tab replaces its copy.
  'node.updated': z.strictObject({ v, node: nodeSummarySchema }),
  // Sent to every tab: a person's message to a run in progress, once it is stored and on its
  // way to the daemon, and the agent's answer, or why it has none, once that is known.
  'run.chat.asked': z.strictObject({ v, chat: pendingChatSchema }),
  'run.chat.reply': z.strictObject({ v, chat: closedChatSchema }),
  // Sent only to the tab whose `run.chat` the server turned away (CHAT_REFUSALS).
  'run.chat.refused': z.strictObject({ v, runId: idSchema, reason: z.enum(CHAT_REFUSALS) }),
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
 * The node daemon streams over its outbound socket (#8). The daemon writes each step to the
 * `steps` table before it sends it, so the server relays it to the UI as `run.step` and
 * doesn't store it again.
 */
/** How often a daemon tells the orchestrator which runs it holds. */
export const NODE_HOLDING_INTERVAL_MS = 20_000;

export const nodeToServerEvents = {
  'node.step': z.strictObject({ v, step: stepSchema }),
  // The runs the daemon is working, sent on every connect and every NODE_HOLDING_INTERVAL_MS.
  // A run no daemon has named for a while is one whose daemon died, and the orchestrator
  // retries it (OrphanSweeper).
  'node.holding': z.strictObject({ v, runIds: z.array(idSchema).max(16) }),
  'node.live': runLiveSchema,
  'node.diff': runDiff,
  'node.run.finished': nodeRunFinishedSchema,
  // A Tier 3 agent asks to run a gated host tool such as `ops.restart`. The node picks the
  // approval id so it can match the `approval.decided` that answers it, and sends the same
  // request again after a reconnect. `expiresAt` is when it stops waiting; the server holds
  // the request open no longer than MAX_APPROVAL_WAIT_MS. `reason` is the agent's own words
  // for why (approvalReason); a daemon from before it was kept sends none.
  'node.approval.request': z.strictObject({
    v,
    approvalId: idSchema,
    runId: idSchema,
    action: pendingApprovalSchema.shape.action,
    args: pendingApprovalSchema.shape.args,
    expiresAt: pendingApprovalSchema.shape.expiresAt,
    reason: pendingApprovalSchema.shape.reason.optional(),
  }),
  // The agent's answer to a `run.chat`, from the reply after it read the message, or why it
  // got none: the queue was full, the agent had submitted, the run ended, or it didn't answer.
  'node.chat.reply': z.discriminatedUnion('status', [
    z.strictObject({
      ...chatIds,
      status: z.literal('answered'),
      answer: z.string().min(1).max(MAX_CHAT_ANSWER_CHARS),
    }),
    z.strictObject({
      ...chatIds,
      status: z.literal('unanswered'),
      reason: z.enum(CHAT_CLOSE_REASONS),
    }),
  ]),
};

/**
 * A decision as a daemon gets it: the approval without its reason, which the daemon sent and
 * has no use for. This keeps `approval.decided` in the shape daemons from before the reason
 * read, so an orchestrator with it still answers them.
 */
export const nodeDecisionSchema = decidedApprovalSchema.omit({ reason: true });

export type NodeDecision = z.infer<typeof nodeDecisionSchema>;

/** `approval` as `approval.decided` carries it to a daemon. */
export function nodeDecision(approval: DecidedApproval): NodeDecision {
  const decision: NodeDecision & Partial<Pick<DecidedApproval, 'reason'>> = { ...approval };
  delete decision.reason;
  return decision;
}

/** UI requests the server relays to the node running the run (#9), and approval outcomes. */
export const serverToNodeEvents = {
  'run.kill': runKill,
  // A tab's message, stored under `chatId` for the daemon's answer. `from` is the name the
  // agent is shown: the person's name, not the `ui:` record.
  'run.chat': z.strictObject({
    ...chatIds,
    from: z.string().min(1).max(100),
    message: chatMessage,
  }),
  'approval.decided': z.strictObject({ v, approval: nodeDecisionSchema }),
};

type Handlers<T extends Record<string, z.ZodType>> = {
  [K in keyof T]: (payload: z.infer<T[K]>) => void;
};

// Event maps in the shape Socket.IO's `Server<Listen, Emit>` and `Socket<Listen, Emit>` take.
export type ServerToUiEvents = Handlers<typeof serverToUiEvents>;
export type UiToServerEvents = Handlers<typeof uiToServerEvents>;
export type NodeToServerEvents = Handlers<typeof nodeToServerEvents>;
export type ServerToNodeEvents = Handlers<typeof serverToNodeEvents>;
