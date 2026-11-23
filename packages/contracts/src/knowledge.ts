import { z } from 'zod';

/** The knowledge graph's trunk. A run writes to `pageagents/<runId>` and reads it over this. */
export const MAIN_BRANCH = 'main';

export const kgBranchNameSchema = z
  .string()
  .regex(/^(main|pageagents\/[0-9a-f-]{36})$/, 'main or pageagents/<runId>');

/** A stable name for a node, such as `file:apps/demo-app/src/shop/cart.ts`. */
export const kgKeySchema = z.string().trim().min(1).max(300);
const kindSchema = z.string().regex(/^[a-z][a-z_]{0,30}$/, 'lower_snake_case, 31 at most');

export const kgWriteNodeSchema = z.strictObject({
  key: kgKeySchema,
  kind: kindSchema,
  title: z.string().trim().min(1).max(300),
  body: z.string().max(20_000).default(''),
});
export type KgWriteNode = z.infer<typeof kgWriteNodeSchema>;

export const kgWriteEdgeSchema = z.strictObject({
  from: kgKeySchema,
  to: kgKeySchema,
  relation: kindSchema,
});
export type KgWriteEdge = z.infer<typeof kgWriteEdgeSchema>;

export const kgSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(1_000),
  branch: kgBranchNameSchema.default(MAIN_BRANCH),
});

export const kgCommitSchema = z.strictObject({
  sha: z.string().regex(/^[0-9a-f]{40}$/, 'a full commit sha'),
});

export const kgNodeSchema = z.strictObject({
  id: z.string(),
  branch: z.string(),
  key: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  version: z.int(),
  updatedAt: z.string(),
});
export type KgNode = z.infer<typeof kgNodeSchema>;

export const kgEdgeSchema = z.strictObject({
  id: z.string(),
  branch: z.string(),
  from: z.string(),
  to: z.string(),
  relation: z.string(),
});
export type KgEdge = z.infer<typeof kgEdgeSchema>;

/** One change to a node or edge. `commitSha` is set only once that commit is on the remote. */
export const kgVersionSchema = z.strictObject({
  id: z.string(),
  branch: z.string(),
  version: z.int(),
  snapshot: z.record(z.string(), z.unknown()),
  runId: z.string().nullable(),
  author: z.string(),
  createdAt: z.string(),
  commitSha: z.string().nullable(),
  pushedAt: z.string().nullable(),
});
export type KgVersion = z.infer<typeof kgVersionSchema>;

export const kgGraphSchema = z.strictObject({
  branch: z.string(),
  /** owner/name of the demo repo, for links to its commits. Null when GitHub isn't set up. */
  repo: z.string().nullable(),
  nodes: z.array(kgNodeSchema),
  edges: z.array(kgEdgeSchema),
});
export type KgGraph = z.infer<typeof kgGraphSchema>;

export const kgNodeDetailSchema = z.strictObject({
  node: kgNodeSchema,
  versions: z.array(kgVersionSchema),
  edges: z.array(kgEdgeSchema),
  linked: z.array(kgNodeSchema),
});
export type KgNodeDetail = z.infer<typeof kgNodeDetailSchema>;

export const kgSearchResultSchema = z.strictObject({
  branch: z.string(),
  query: z.string(),
  matches: z.array(z.strictObject({ node: kgNodeSchema, score: z.number() })),
  neighbors: z.array(kgNodeSchema),
  edges: z.array(kgEdgeSchema),
});
export type KgSearchResult = z.infer<typeof kgSearchResultSchema>;

export const kgBranchSchema = z.strictObject({
  name: z.string(),
  versions: z.int(),
  /** Versions whose commit isn't on the remote yet, or never will be. */
  unpushed: z.int(),
  updatedAt: z.string().nullable(),
});
export type KgBranch = z.infer<typeof kgBranchSchema>;
