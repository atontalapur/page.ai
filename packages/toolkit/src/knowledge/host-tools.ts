import {
  kgNodeDetailSchema,
  kgSearchResultSchema,
  type KgNode,
  type KgNodeDetail,
  type KgSearchResult,
} from '@page/contracts';
import type {
  HostToolCall,
  HostToolName,
  HostToolOutcome,
  HostTools,
  KgWriteCall,
} from '../exec/types.ts';

const KG_TOOLS = new Set<HostToolName>(['kg.search', 'kg.read', 'kg.write']);
// What the agent reads of each node's body in a search; kg.read shows all of it.
const SNIPPET_CHARS = 400;

export interface KnowledgeHostToolsOptions {
  /** The orchestrator's base URL, such as `https://orchestrator.example.com`. */
  orchestratorUrl: string;
  /** NODE_SHARED_SECRET, which the orchestrator's knowledge routes check. */
  secret: string;
  runId: string;
  /** The run's stop signal. Once it fires, no request goes out. */
  signal?: AbortSignal;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const fail = (output: string): HostToolOutcome => ({ ok: false, output });

/**
 * `kg.search`, `kg.read` and `kg.write` for one run, through the orchestrator's knowledge
 * routes; the agent never reaches the database. Reads see the run's branch over main, and
 * writes go to the run's branch only. `commit` tells the orchestrator a push of the run's
 * branch reached GitHub, so the versions written before it carry that commit.
 */
export class KnowledgeHostTools implements HostTools {
  private readonly options: KnowledgeHostToolsOptions;
  private readonly fetch: (url: string, init: RequestInit) => Promise<Response>;

  constructor(options: KnowledgeHostToolsOptions) {
    this.options = { ...options, orchestratorUrl: options.orchestratorUrl.replace(/\/$/, '') };
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  handles(tool: HostToolName): boolean {
    return KG_TOOLS.has(tool);
  }

  async run(call: HostToolCall, timeoutMs: number): Promise<HostToolOutcome> {
    const signal = this.signalFor(timeoutMs);
    try {
      switch (call.tool) {
        case 'kg.search': {
          const result = kgSearchResultSchema.parse(
            await this.request('POST', '/search', { query: call.query }, signal),
          );
          return { ok: true, output: formatSearch(result) };
        }
        case 'kg.read': {
          const detail = kgNodeDetailSchema.parse(
            await this.request(
              'GET',
              `/node?key=${encodeURIComponent(call.key)}`,
              undefined,
              signal,
            ),
          );
          return { ok: true, output: formatNode(detail) };
        }
        case 'kg.write':
          return await this.write(call, signal);
        default:
          return fail(`${call.tool} is not a knowledge tool`);
      }
    } catch (error) {
      if (this.options.signal?.aborted) return fail(`${call.tool} stopped: the run was stopped`);
      return fail(`${call.tool}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Records that GitHub accepted a push of the run's branch as `sha`. */
  async commit(sha: string): Promise<number> {
    const body = (await this.request('POST', '/commits', { sha }, this.signalFor(15_000))) as {
      stamped?: number;
    };
    return body.stamped ?? 0;
  }

  private async write(call: KgWriteCall, signal: AbortSignal): Promise<HostToolOutcome> {
    const node = (await this.request(
      'POST',
      '/nodes',
      { key: call.key, kind: call.nodeKind, title: call.title, body: call.body },
      signal,
    )) as KgNode;
    const linked: string[] = [];
    const refused: string[] = [];
    for (const link of call.links) {
      try {
        await this.request(
          'POST',
          '/edges',
          { from: call.key, to: link.to, relation: link.relation },
          signal,
        );
        linked.push(`${link.relation} ${link.to}`);
      } catch (error) {
        refused.push(
          `${link.relation} ${link.to}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const lines = [`wrote ${node.key} (version ${node.version}) to this run's branch`];
    if (linked.length > 0) lines.push(`linked: ${linked.join('; ')}`);
    if (refused.length > 0) lines.push(`not linked: ${refused.join('; ')}`);
    return { ok: refused.length === 0, output: lines.join('\n') };
  }

  private signalFor(timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    return this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
  }

  private async request(
    method: string,
    path: string,
    body: object | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { orchestratorUrl, runId, secret } = this.options;
    const res = await this.fetch(`${orchestratorUrl}/kg/runs/${runId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === 'string') message = parsed.message;
      } catch {
        // Not JSON: keep the text.
      }
      throw new Error(`the orchestrator answered ${res.status}: ${message}`);
    }
    return text === '' ? undefined : JSON.parse(text);
  }
}

const snippet = (body: string) =>
  body.length <= SNIPPET_CHARS ? body : `${body.slice(0, SNIPPET_CHARS)}…`;

/** A search as the agent reads it: the matches, then what they link to. */
export function formatSearch(result: KgSearchResult): string {
  if (result.matches.length === 0) {
    return 'The knowledge graph has nothing yet. Write what you learn with a kg write block.';
  }
  const lines = ['Matches, nearest first:'];
  for (const { node, score } of result.matches) {
    lines.push(`- ${node.key} [${node.kind}] ${node.title} (score ${score.toFixed(2)})`);
    if (node.body) lines.push(`  ${snippet(node.body).replace(/\n/g, '\n  ')}`);
  }
  if (result.edges.length > 0) {
    lines.push('', 'Links:');
    for (const e of result.edges) lines.push(`- ${e.from} ${e.relation} ${e.to}`);
  }
  if (result.neighbors.length > 0) {
    lines.push('', 'Linked nodes:');
    for (const n of result.neighbors) lines.push(`- ${n.key} [${n.kind}] ${n.title}`);
  }
  return lines.join('\n');
}

/** One node as the agent reads it: everything in it, and its links. */
export function formatNode({ node, edges, versions }: KgNodeDetail): string {
  const lines = [
    `${node.key} [${node.kind}] ${node.title}`,
    `version ${node.version} on ${node.branch}`,
  ];
  if (node.body) lines.push('', node.body);
  if (edges.length > 0) {
    lines.push('', 'Links:');
    for (const e of edges) lines.push(`- ${e.from} ${e.relation} ${e.to}`);
  }
  lines.push('', `${versions.length} version(s) in its history.`);
  return lines.join('\n');
}
