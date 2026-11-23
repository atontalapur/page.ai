import { z } from 'zod';
import { timestampSchema } from './common.ts';
import { runSchema, stepSchema } from './db.ts';

// Node daemons as the agents page shows them: `GET /nodes`, `GET /nodes/:name/runs` and the
// `node.updated` event.

/** The longest name a daemon can go by, the length of one DNS label. */
export const MAX_NODE_NAME_CHARS = 63;

/**
 * A node daemon's name: NODE_NAME, or its hostname. The daemon sends it in its socket
 * handshake, the orchestrator records it with each run the daemon works, and the UI links to
 * `/agents/<name>`, so it keeps to what a hostname may hold.
 */
export const nodeNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'letters, digits, dots, underscores and hyphens, starting with a letter or digit',
  )
  .max(MAX_NODE_NAME_CHARS);

/**
 * `raw` made into a node name: each character a name can't hold becomes a hyphen, anything
 * before the first letter or digit goes, and the rest is cut to the longest name. For a
 * hostname the daemon falls back on, and for a daemon that sent no name.
 */
export function toNodeName(raw: string): string {
  const name = raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, MAX_NODE_NAME_CHARS);
  return name === '' ? 'node' : name;
}

/**
 * One run as the agents page lists it: its row (or what the issue says of it while it has
 * none), the issue it works on, and how far it has got.
 */
export const nodeRunSchema = runSchema.extend({
  issueTitle: z.string().min(1),
  stepCount: z.int().nonnegative(),
  // The newest step. Null before the first.
  lastStep: stepSchema.nullable(),
});

export type NodeRun = z.infer<typeof nodeRunSchema>;

/**
 * A daemon as the agents page shows it. Connection state is the instance's own: a daemon is
 * connected when it holds a socket to the instance that answered.
 */
export const nodeSummarySchema = z.strictObject({
  name: nodeNameSchema,
  connected: z.boolean(),
  // Connected: since its socket connected. Not connected: since it left, when this instance
  // saw it go. Null for a daemon known only from the runs it worked.
  since: timestampSchema.nullable(),
  // The runs it holds now: from its first event naming a run until it reports the run
  // finished, or disconnects.
  current: z.array(nodeRunSchema),
  // When it took its newest run. Null when it has worked none.
  lastRunAt: timestampSchema.nullable(),
});

export type NodeSummary = z.infer<typeof nodeSummarySchema>;
