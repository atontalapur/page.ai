import { describe, expect, it, vi } from 'vitest';
import { RAILWAY_API, RailwayDeployer, type RailwayDeployerOptions } from './railway-deployer.ts';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

function setup(reply: unknown, status = 200, options: Partial<RailwayDeployerOptions> = {}) {
  const sent: Sent[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Sent['body'],
    });
    const body = typeof reply === 'string' ? reply : JSON.stringify(reply);
    return Promise.resolve(new Response(body, { status }));
  });
  const deployer = new RailwayDeployer({
    token: 'tok',
    projectId: 'p',
    environmentId: 'e',
    serviceId: 's',
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...options,
  });
  return { deployer, sent };
}

const node = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  node: { id, status: 'SUCCESS', createdAt, canRollback: true, meta: null, ...extra },
});

describe('RailwayDeployer', () => {
  it('lists the service deployments newest first, with the commit', async () => {
    const { deployer, sent } = setup({
      data: {
        deployments: {
          edges: [
            node('old', '2026-11-01T00:00:00Z', {
              status: 'REMOVED',
              meta: { commitHash: 'abc', x: 1 },
            }),
            node('new', '2026-11-02T00:00:00Z'),
          ],
        },
      },
    });
    expect(await deployer.listDeployments(5)).toEqual([
      {
        id: 'new',
        status: 'SUCCESS',
        createdAt: '2026-11-02T00:00:00Z',
        commitSha: null,
        canRollback: true,
      },
      {
        id: 'old',
        status: 'REMOVED',
        createdAt: '2026-11-01T00:00:00Z',
        commitSha: 'abc',
        canRollback: true,
      },
    ]);
    expect(sent[0]).toMatchObject({
      url: RAILWAY_API,
      headers: { 'Project-Access-Token': 'tok' },
      body: {
        variables: { input: { projectId: 'p', environmentId: 'e', serviceId: 's' }, first: 5 },
      },
    });
  });

  it('sends a rollback, with an account token as a bearer token', async () => {
    const { deployer, sent } = setup({ data: { deploymentRollback: true } }, 200, {
      tokenKind: 'account',
      endpoint: 'http://railway.test/graphql',
    });
    await deployer.rollbackTo('dep-1');
    expect(sent[0]).toMatchObject({
      url: 'http://railway.test/graphql',
      headers: { authorization: 'Bearer tok' },
      body: { variables: { id: 'dep-1' } },
    });
    expect(sent[0]?.body.query).toContain('deploymentRollback');
  });

  it('fails when Railway refuses the rollback', async () => {
    const { deployer } = setup({ data: { deploymentRollback: false } });
    await expect(deployer.rollbackTo('dep-1')).rejects.toThrow('did not accept');
  });

  it('surfaces GraphQL errors, HTTP errors and malformed replies', async () => {
    await expect(
      setup({
        errors: [{ message: 'Not Authorized' }, { message: 'again' }],
      }).deployer.listDeployments(1),
    ).rejects.toThrow('Railway API: Not Authorized; again');
    await expect(
      setup('<html>bad gateway</html>', 502).deployer.listDeployments(1),
    ).rejects.toThrow('answered 502');
    await expect(setup({ data: null }).deployer.listDeployments(1)).rejects.toThrow('no data');
    await expect(
      setup({ data: { deployments: {} } }).deployer.listDeployments(1),
    ).rejects.toThrow();
  });
});
