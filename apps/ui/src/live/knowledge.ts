import {
  kgBranchSchema,
  kgGraphSchema,
  kgNodeDetailSchema,
  kgSearchResultSchema,
  type KgBranch,
  type KgGraph,
  type KgNodeDetail,
  type KgSearchResult,
} from '@page/contracts';
import { readToken } from './token';

const headers = (json = false) => ({
  authorization: `Bearer ${readToken() ?? ''}`,
  accept: 'application/json',
  ...(json ? { 'content-type': 'application/json' } : {}),
});

async function read<T>(res: Response, schema: { parse(value: unknown): T }): Promise<T> {
  if (!res.ok) throw new Error(`The orchestrator answered ${res.status}.`);
  return schema.parse(await res.json());
}

/** The branches of the knowledge graph: main first, then the newest run branches. */
export async function loadBranches(): Promise<KgBranch[]> {
  return read(await fetch('/kg/branches', { headers: headers() }), {
    parse: (v: unknown) => (v as unknown[]).map((b) => kgBranchSchema.parse(b)),
  });
}

/** Every node and edge `branch` sees: its own over main. */
export async function loadGraph(branch: string): Promise<KgGraph> {
  const q = new URLSearchParams({ branch });
  return read(await fetch(`/kg/graph?${q}`, { headers: headers() }), kgGraphSchema);
}

/** One node with its history and links. */
export async function loadNode(branch: string, key: string): Promise<KgNodeDetail> {
  const q = new URLSearchParams({ branch, key });
  return read(await fetch(`/kg/node?${q}`, { headers: headers() }), kgNodeDetailSchema);
}

export async function searchGraph(branch: string, query: string): Promise<KgSearchResult> {
  return read(
    await fetch('/kg/search', {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ branch, query }),
    }),
    kgSearchResultSchema,
  );
}
