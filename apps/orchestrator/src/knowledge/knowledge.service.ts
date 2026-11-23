import { Inject, Injectable } from '@nestjs/common';
import {
  MAIN_BRANCH,
  type KgBranch,
  type KgEdge,
  type KgGraph,
  type KgNode,
  type KgNodeDetail,
  type KgSearchResult,
  type KgVersion,
  type KgWriteEdge,
  type KgWriteNode,
} from '@page/contracts';
import { cosine, type Embedder } from '@page/model-client';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { Database, Db, KgEdgesTable, KgNodesTable, KgVersionsTable } from '../db/database.ts';
import type { Logger } from '../logger.ts';
import type { Config } from '../config.ts';
import { CONFIG, DB, EMBEDDER, LOGGER } from '../tokens.ts';

/** The branch a run writes to: the same name as the git branch its fix is pushed to. */
export const runBranch = (runId: string) => `pageagents/${runId}`;

const SEARCH_LIMIT = 5;
// Nodes re-embedded per search at most, when the embedding model changed or a write failed.
const REEMBED_BATCH = 64;
// Compare-and-swap attempts before a write gives up as conflicting.
const MAX_CAS_ATTEMPTS = 8;

export class KgNotFoundError extends Error {}

/** A write that lost the race to other writers MAX_CAS_ATTEMPTS times in a row. */
export class KgConflictError extends Error {}

/** A write the graph refuses, such as an edge to a node that doesn't exist. */
export class KgRefusedError extends Error {}

type NodeRow = Selectable<KgNodesTable>;
type EdgeRow = Selectable<KgEdgesTable>;

const embedText = (n: { kind: string; title: string; body: string }) =>
  `${n.kind}: ${n.title}\n\n${n.body}`;

/**
 * The knowledge graph the agents read and write, kept in Postgres and reached only through
 * the orchestrator's routes. Every write is a new version with its run and author. A
 * version's commit is recorded only once that commit is on the remote: `stampCommit` after
 * a push GitHub accepted, and `promote` with the merge commit of the run's PR.
 *
 * A run's branch is read over `main`: its own nodes and edges, and main's for every key it
 * hasn't written.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async graph(branch: string): Promise<KgGraph> {
    const [nodes, edges] = await Promise.all([
      this.visibleNodes(branch),
      this.visibleEdges(branch),
    ]);
    return {
      branch,
      repo: this.config.github?.repo ?? null,
      nodes: nodes.map(toNode),
      edges: edges.map(toEdge),
    };
  }

  async branches(): Promise<KgBranch[]> {
    const rows = await this.db
      .selectFrom('kg_versions')
      .select([
        'branch',
        sql<number>`count(*)::int`.as('versions'),
        sql<number>`count(*) filter (where commit_sha is null)::int`.as('unpushed'),
        sql<Date>`max(created_at)`.as('updatedAt'),
      ])
      .groupBy('branch')
      .execute();
    const all: KgBranch[] = rows.map((r) => ({
      name: r.branch,
      versions: Number(r.versions),
      unpushed: Number(r.unpushed),
      updatedAt: new Date(r.updatedAt).toISOString(),
    }));
    if (!all.some((b) => b.name === MAIN_BRANCH)) {
      all.push({ name: MAIN_BRANCH, versions: 0, unpushed: 0, updatedAt: null });
    }
    // main first, then the newest run branches.
    return all.sort((a, b) =>
      a.name === MAIN_BRANCH
        ? -1
        : b.name === MAIN_BRANCH
          ? 1
          : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );
  }

  /** A node as `branch` sees it, with every version of it there and its edges. */
  async node(branch: string, key: string): Promise<KgNodeDetail> {
    const row = await this.visibleNode(branch, key);
    if (!row) throw new KgNotFoundError(`no node ${key} on ${branch}`);
    const versions = await this.db
      .selectFrom('kg_versions')
      .selectAll()
      .where('entity', '=', 'node')
      .where('entity_id', '=', row.id)
      .orderBy('version', 'desc')
      .execute();
    const edges = (await this.visibleEdges(branch)).filter(
      (e) => e.from_key === key || e.to_key === key,
    );
    const keys = [...new Set(edges.flatMap((e) => [e.from_key, e.to_key]))].filter(
      (k) => k !== key,
    );
    const linked = (await this.visibleNodes(branch)).filter((n) => keys.includes(n.key));
    return {
      node: toNode(row),
      versions: versions.map(toVersion),
      edges: edges.map(toEdge),
      linked: linked.map(toNode),
    };
  }

  /** Writes a node on `branch`, as a new version when it changed. Embeds it first. */
  async writeNode(
    branch: string,
    input: KgWriteNode,
    by: { runId: string | null; author: string },
  ): Promise<KgNode> {
    const [embedding] = await this.embedder.embed([embedText(input)]);
    return toNode(await this.casNode(branch, input, embedding ?? null, by));
  }

  /** Links two nodes that `branch` can see. Writing a link it already has changes nothing. */
  async writeEdge(
    branch: string,
    input: KgWriteEdge,
    by: { runId: string | null; author: string },
  ): Promise<KgEdge> {
    for (const key of [input.from, input.to]) {
      if (!(await this.visibleNode(branch, key))) {
        throw new KgRefusedError(`no node ${key} on ${branch}; write it first`);
      }
    }
    const onMain = await this.findEdge(MAIN_BRANCH, input);
    if (onMain) return toEdge(onMain);
    return toEdge(await this.insertEdge(branch, input, by));
  }

  /**
   * Vector search, then the graph: the nodes nearest the query, and every node one edge
   * away from them, with those edges.
   */
  async search(branch: string, query: string, limit = SEARCH_LIMIT): Promise<KgSearchResult> {
    const [queryVector] = await this.embedder.embed([query]);
    let nodes = await this.visibleNodes(branch);
    nodes = await this.reembedStale(nodes);
    const ranked = nodes
      .filter((n) => n.embedding?.length === this.embedder.dimensions)
      .map((n) => ({ node: n, score: cosine(queryVector ?? [], n.embedding ?? []) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const hit = new Set(ranked.map((r) => r.node.key));
    const edges = (await this.visibleEdges(branch)).filter(
      (e) => hit.has(e.from_key) || hit.has(e.to_key),
    );
    const near = new Set(edges.flatMap((e) => [e.from_key, e.to_key]).filter((k) => !hit.has(k)));
    return {
      branch,
      query,
      matches: ranked.map((r) => ({ node: toNode(r.node), score: r.score })),
      neighbors: nodes.filter((n) => near.has(n.key)).map(toNode),
      edges: edges.map(toEdge),
    };
  }

  /**
   * Records that `sha` is on the remote for every version on `branch` that has no commit
   * yet: they were written before the push that carried it. Returns how many it stamped.
   */
  async stampCommit(branch: string, sha: string): Promise<number> {
    const rows = await this.db
      .updateTable('kg_versions')
      .set({ commit_sha: sha, pushed_at: sql<Date>`now()` })
      .where('branch', '=', branch)
      .where('commit_sha', 'is', null)
      .returning('id')
      .execute();
    if (rows.length > 0) this.logger.info({ branch, sha, versions: rows.length }, 'kg commit');
    return rows.length;
  }

  /**
   * Copies a merged run branch onto main: each of its nodes and edges becomes main's next
   * version, carrying the merge commit, which is on the remote by then. Each entity is
   * written on its own, so a promotion that stops part way can simply run again: a node
   * already on main as the branch has it gets no new version.
   */
  async promote(branch: string, mergeSha: string, author: string): Promise<number> {
    const runId = branch.slice('pageagents/'.length);
    const nodes = await this.db
      .selectFrom('kg_nodes')
      .selectAll()
      .where('branch', '=', branch)
      .execute();
    const edges = await this.db
      .selectFrom('kg_edges')
      .selectAll()
      .where('branch', '=', branch)
      .execute();
    const by = { runId, author, commit: mergeSha };
    for (const n of nodes) await this.casNode(MAIN_BRANCH, n, n.embedding, by);
    for (const e of edges) {
      await this.insertEdge(
        MAIN_BRANCH,
        { from: e.from_key, to: e.to_key, relation: e.relation },
        by,
      );
    }
    this.logger.info({ branch, mergeSha, nodes: nodes.length, edges: edges.length }, 'kg promoted');
    return nodes.length + edges.length;
  }

  /**
   * Writes a node without locking it: read it, then update only if its version is still
   * the one read (compare and swap), or insert with `on conflict do nothing` for a new key.
   * A writer that loses the race finds no row changed, reads again and retries. Each
   * winning write and its history row commit together, and the history's unique
   * (entity, entity_id, version) keeps two writers from recording the same version.
   */
  private async casNode(
    branch: string,
    input: { key: string; kind: string; title: string; body: string },
    embedding: number[] | null,
    by: { runId: string | null; author: string; commit?: string },
  ): Promise<NodeRow> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const current = await this.db
        .selectFrom('kg_nodes')
        .selectAll()
        .where('branch', '=', branch)
        .where('key', '=', input.key)
        .executeTakeFirst();
      if (
        current &&
        current.kind === input.kind &&
        current.title === input.title &&
        current.body === input.body
      ) {
        return current;
      }
      // A run's first write of a key main has continues main's numbering.
      const base = current?.version ?? (await this.mainVersion(input.key));
      const written = await this.db.transaction().execute(async (trx) => {
        const fields = {
          kind: input.kind,
          title: input.title,
          body: input.body,
          embedding,
          version: base + 1,
        };
        const row = current
          ? await trx
              .updateTable('kg_nodes')
              .set({ ...fields, updated_at: sql<Date>`now()` })
              .where('id', '=', current.id)
              .where('version', '=', current.version)
              .returningAll()
              .executeTakeFirst()
          : await trx
              .insertInto('kg_nodes')
              .values({ ...fields, branch, key: input.key })
              .onConflict((oc) => oc.columns(['branch', 'key']).doNothing())
              .returningAll()
              .executeTakeFirst();
        if (!row) return undefined;
        await this.addVersion(trx, 'node', row.id, branch, row.version, nodeSnapshot(row), by);
        return row;
      });
      if (written) return written;
    }
    throw new KgConflictError(`${input.key} on ${branch} kept changing; try the write again`);
  }

  private findEdge(branch: string, input: KgWriteEdge): Promise<EdgeRow | undefined> {
    return this.db
      .selectFrom('kg_edges')
      .selectAll()
      .where('branch', '=', branch)
      .where('from_key', '=', input.from)
      .where('to_key', '=', input.to)
      .where('relation', '=', input.relation)
      .executeTakeFirst();
  }

  /** Inserts an edge unless it is there already, with no lock: the unique key decides. */
  private async insertEdge(
    branch: string,
    input: KgWriteEdge,
    by: { runId: string | null; author: string; commit?: string },
  ): Promise<EdgeRow> {
    const inserted = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('kg_edges')
        .values({ branch, from_key: input.from, to_key: input.to, relation: input.relation })
        .onConflict((oc) => oc.columns(['branch', 'from_key', 'to_key', 'relation']).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (row)
        await this.addVersion(trx, 'edge', row.id, branch, row.version, edgeSnapshot(row), by);
      return row;
    });
    return inserted ?? (await this.findEdge(branch, input))!;
  }

  private async addVersion(
    trx: Transaction<Database>,
    entity: 'node' | 'edge',
    entityId: string,
    branch: string,
    version: number,
    snapshot: Record<string, unknown>,
    by: { runId: string | null; author: string; commit?: string },
  ) {
    await trx
      .insertInto('kg_versions')
      .values({
        entity,
        entity_id: entityId,
        branch,
        version,
        snapshot: JSON.stringify(snapshot),
        run_id: by.runId,
        author: by.author,
        commit_sha: by.commit ?? null,
        pushed_at: by.commit === undefined ? null : new Date(),
      })
      .execute();
  }

  private async mainVersion(key: string): Promise<number> {
    const row = await this.db
      .selectFrom('kg_nodes')
      .select('version')
      .where('branch', '=', MAIN_BRANCH)
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.version ?? 0;
  }

  private async visibleNode(branch: string, key: string): Promise<NodeRow | undefined> {
    return this.db
      .selectFrom('kg_nodes')
      .selectAll()
      .where('key', '=', key)
      .where('branch', 'in', [branch, MAIN_BRANCH])
      .orderBy(sql`branch = ${MAIN_BRANCH}`)
      .executeTakeFirst();
  }

  private async visibleNodes(branch: string): Promise<NodeRow[]> {
    const rows = await this.db
      .selectFrom('kg_nodes')
      .selectAll()
      .where('branch', 'in', [branch, MAIN_BRANCH])
      .execute();
    const byKey = new Map<string, NodeRow>();
    for (const row of rows) {
      if (row.branch === branch || !byKey.has(row.key)) byKey.set(row.key, row);
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  private async visibleEdges(branch: string): Promise<EdgeRow[]> {
    const rows = await this.db
      .selectFrom('kg_edges')
      .selectAll()
      .where('branch', 'in', [branch, MAIN_BRANCH])
      .execute();
    const seen = new Map<string, EdgeRow>();
    for (const row of rows) {
      const id = `${row.from_key}\u0000${row.relation}\u0000${row.to_key}`;
      if (row.branch === branch || !seen.has(id)) seen.set(id, row);
    }
    return [...seen.values()];
  }

  /** Embeds nodes whose vector is missing or from another model size, and stores them. */
  private async reembedStale(nodes: NodeRow[]): Promise<NodeRow[]> {
    const stale = nodes
      .filter((n) => n.embedding?.length !== this.embedder.dimensions)
      .slice(0, REEMBED_BATCH);
    if (stale.length === 0) return nodes;
    const vectors = await this.embedder.embed(stale.map(embedText));
    const fresh = new Map<string, number[]>();
    for (const [i, node] of stale.entries()) {
      const vector = vectors[i];
      if (!vector) continue;
      fresh.set(node.id, vector);
      await this.db
        .updateTable('kg_nodes')
        .set({ embedding: vector })
        .where('id', '=', node.id)
        .execute();
    }
    return nodes.map((n) => (fresh.has(n.id) ? { ...n, embedding: fresh.get(n.id)! } : n));
  }
}

function nodeSnapshot(row: NodeRow): Record<string, unknown> {
  return { key: row.key, kind: row.kind, title: row.title, body: row.body };
}

function edgeSnapshot(row: EdgeRow): Record<string, unknown> {
  return { from: row.from_key, to: row.to_key, relation: row.relation };
}

function toNode(row: NodeRow): KgNode {
  return {
    id: row.id,
    branch: row.branch,
    key: row.key,
    kind: row.kind,
    title: row.title,
    body: row.body,
    version: row.version,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toEdge(row: EdgeRow): KgEdge {
  return {
    id: row.id,
    branch: row.branch,
    from: row.from_key,
    to: row.to_key,
    relation: row.relation,
  };
}

function toVersion(row: Selectable<KgVersionsTable>): KgVersion {
  return {
    id: String(row.id),
    branch: row.branch,
    version: row.version,
    snapshot: row.snapshot,
    runId: row.run_id,
    author: row.author,
    createdAt: new Date(row.created_at).toISOString(),
    commitSha: row.commit_sha,
    pushedAt: row.pushed_at === null ? null : new Date(row.pushed_at).toISOString(),
  };
}
