import { z } from 'zod';
import type { Deployer, Deployment } from './deployer.ts';

export const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
export const RAILWAY_TIMEOUT_MS = 15_000;

export interface RailwayDeployerOptions {
  token: string;
  /**
   * `project` (the default) is a project token, sent as `Project-Access-Token` and scoped to
   * one environment, so it can't touch production. `account` is an account or team token,
   * sent as a bearer token.
   */
  tokenKind?: 'project' | 'account';
  projectId: string;
  environmentId: string;
  serviceId: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEPLOYMENTS = `query Deployments($input: DeploymentListInput!, $first: Int) {
  deployments(input: $input, first: $first) {
    edges { node { id status createdAt canRollback meta } }
  }
}`;

const ROLLBACK = `mutation Rollback($id: String!) { deploymentRollback(id: $id) }`;

const graphqlErrors = z.array(z.object({ message: z.string() }));

const deploymentsData = z.object({
  deployments: z.object({
    edges: z.array(
      z.object({
        node: z.object({
          id: z.string(),
          status: z.string(),
          createdAt: z.string(),
          canRollback: z.boolean(),
          // Free-form JSON; deploys from GitHub carry the commit here.
          meta: z.object({ commitHash: z.string().optional() }).loose().nullish(),
        }),
      }),
    ),
  }),
});

const rollbackData = z.object({ deploymentRollback: z.boolean() });

/** A Deployer for one Railway service in one environment, over Railway's GraphQL API. */
export class RailwayDeployer implements Deployer {
  private readonly options: RailwayDeployerOptions;

  constructor(options: RailwayDeployerOptions) {
    this.options = options;
  }

  async listDeployments(limit: number): Promise<Deployment[]> {
    const { projectId, environmentId, serviceId } = this.options;
    const data = deploymentsData.parse(
      await this.request(DEPLOYMENTS, {
        input: { projectId, environmentId, serviceId },
        first: limit,
      }),
    );
    // Railway lists newest first; sort anyway so the port's order doesn't hang on that.
    return data.deployments.edges
      .map(({ node }) => ({
        id: node.id,
        status: node.status,
        createdAt: node.createdAt,
        commitSha: node.meta?.commitHash ?? null,
        canRollback: node.canRollback,
      }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async rollbackTo(id: string): Promise<void> {
    const data = rollbackData.parse(await this.request(ROLLBACK, { id }));
    if (!data.deploymentRollback) throw new Error(`Railway did not accept the rollback to ${id}`);
  }

  private async request(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const {
      token,
      tokenKind = 'project',
      endpoint = RAILWAY_API,
      timeoutMs = RAILWAY_TIMEOUT_MS,
      fetch: doFetch = fetch,
    } = this.options;
    const auth: Record<string, string> =
      tokenKind === 'project'
        ? { 'Project-Access-Token': token }
        : { authorization: `Bearer ${token}` };

    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: unknown;
      errors?: unknown;
    } | null;
    const errors = graphqlErrors.safeParse(body?.errors);
    if (errors.success && errors.data.length > 0) {
      throw new Error(`Railway API: ${errors.data.map((e) => e.message).join('; ')}`);
    }
    if (!res.ok || body?.data == null) {
      throw new Error(`Railway API answered ${res.status} with no data`);
    }
    return body.data;
  }
}
