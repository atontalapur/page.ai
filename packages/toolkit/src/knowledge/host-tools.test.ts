import { describe, expect, it } from 'vitest';
import { KnowledgeHostTools } from './host-tools.ts';

const runId = '11111111-1111-4111-8111-111111111111';
const node = (key: string) => ({
  id: key,
  branch: `pageagents/${runId}`,
  key,
  kind: 'file',
  title: `Title of ${key}`,
  body: 'what it does',
  version: 1,
  updatedAt: '2026-11-23T10:00:00.000Z',
});

/** The orchestrator's knowledge routes, answering from `routes`, with each request kept. */
function orchestrator(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const requests: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const fetch = (url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const method = init.method ?? 'GET';
    requests.push({ method, url, auth: new Headers(init.headers).get('authorization'), body });
    const path = new URL(url).pathname.replace(`/kg/runs/${runId}`, '');
    const route = routes[`${method} ${path}`];
    const [status, reply] = route ? route(body) : [404, { message: 'no route' }];
    return Promise.resolve(Response.json(reply, { status }));
  };
  const tools = new KnowledgeHostTools({
    orchestratorUrl: 'https://orch.example.com/',
    secret: 'node-secret',
    runId,
    fetch,
  });
  return { tools, requests };
}

describe('KnowledgeHostTools', () => {
  it("searches the run's branch with the node secret, and shows matches and links", async () => {
    const { tools, requests } = orchestrator({
      'POST /search': () => [
        200,
        {
          branch: `pageagents/${runId}`,
          query: 'cart',
          matches: [{ node: node('file:cart.ts'), score: 0.91 }],
          neighbors: [node('file:money.ts')],
          edges: [
            {
              id: 'e',
              branch: 'main',
              from: 'file:cart.ts',
              to: 'file:money.ts',
              relation: 'imports',
            },
          ],
        },
      ],
    });
    const out = await tools.run({ kind: 'host_tool', tool: 'kg.search', query: 'cart' }, 5000);
    expect(out.ok).toBe(true);
    expect(out.output).toContain('file:cart.ts [file] Title of file:cart.ts (score 0.91)');
    expect(out.output).toContain('file:cart.ts imports file:money.ts');
    expect(requests[0]).toMatchObject({
      url: `https://orch.example.com/kg/runs/${runId}/search`,
      auth: 'Bearer node-secret',
      body: { query: 'cart' },
    });
  });

  it('writes the node, then each link, and says which links it could not make', async () => {
    const { tools, requests } = orchestrator({
      'POST /nodes': () => [201, node('file:cart.ts')],
      'POST /edges': (body) =>
        (body as { to: string }).to === 'file:money.ts'
          ? [201, {}]
          : [400, { message: 'no node file:gone.ts on the branch; write it first' }],
    });
    const out = await tools.run(
      {
        kind: 'host_tool',
        tool: 'kg.write',
        key: 'file:cart.ts',
        nodeKind: 'file',
        title: 'Cart',
        body: 'sums lines',
        links: [
          { relation: 'imports', to: 'file:money.ts' },
          { relation: 'imports', to: 'file:gone.ts' },
        ],
      },
      5000,
    );
    expect(out.ok).toBe(false);
    expect(out.output).toContain('linked: imports file:money.ts');
    expect(out.output).toContain('not linked: imports file:gone.ts');
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname.split('/').pop()}`)).toEqual([
      'POST nodes',
      'POST edges',
      'POST edges',
    ]);
  });

  it('records a pushed commit', async () => {
    const { tools, requests } = orchestrator({ 'POST /commits': () => [200, { stamped: 2 }] });
    expect(await tools.commit('a'.repeat(40))).toBe(2);
    expect(requests[0]?.body).toEqual({ sha: 'a'.repeat(40) });
  });

  it("gives the agent the orchestrator's refusal in words", async () => {
    const { tools } = orchestrator({
      'POST /search': () => [403, { message: 'run is not in progress' }],
    });
    const out = await tools.run({ kind: 'host_tool', tool: 'kg.search', query: 'x' }, 5000);
    expect(out).toEqual({
      ok: false,
      output: 'kg.search: the orchestrator answered 403: run is not in progress',
    });
  });
});
