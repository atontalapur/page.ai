import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { posthogWebhookFixture } from '@page/contracts/fixtures';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(deps, false);
await app.init();
await app.getHttpAdapter().getInstance().ready();
afterAll(async () => {
  await app.close();
  await deps.close();
});

const id = '00000000-0000-4000-8000-000000000000';
// Every route the API token guards. A new route belongs here too.
const routes = [
  { method: 'GET', url: '/issues' },
  { method: 'POST', url: '/issues', payload: { fingerprint: 'auth-1', title: 'Boom' } },
  { method: 'GET', url: `/issues/${id}` },
  { method: 'GET', url: `/issues/${id}/events` },
  { method: 'GET', url: `/issues/${id}/runs` },
  { method: 'POST', url: `/issues/${id}/events`, payload: { type: 'kill' } },
  { method: 'GET', url: '/debug' },
  { method: 'POST', url: '/debug/errors', payload: { kind: 'synthetic' } },
  { method: 'POST', url: '/debug/reset' },
  { method: 'GET', url: `/issues/${id}/decisions` },
  { method: 'GET', url: '/kg/branches' },
  { method: 'GET', url: '/kg/graph' },
  { method: 'GET', url: '/kg/node?key=file:x.ts' },
  { method: 'POST', url: '/kg/search', payload: { query: 'cart' } },
  { method: 'POST', url: '/kg/seed' },
  { method: 'GET', url: '/github/app' },
  { method: 'POST', url: '/github/app/manifest' },
] as const;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('API token', () => {
  it.each(routes)('$method $url returns 401 without the token or with a wrong one', async (r) => {
    // An address per route, so the wrong tokens here stay under the per-address limit.
    const remoteAddress = `10.0.0.${routes.indexOf(r) + 1}`;
    for (const headers of [{}, bearer('wrong'), { authorization: testConfig.apiToken ?? '' }]) {
      const res = await app.inject({ ...r, headers, remoteAddress });
      expect(res.statusCode).toBe(401);
    }
  });

  it('lets a valid token through', async () => {
    const headers = bearer(testConfig.apiToken ?? '');
    expect((await app.inject({ method: 'GET', url: '/issues', headers })).statusCode).toBe(200);
    // Past the guard: an unknown issue is a 404, not a 401.
    const missing = await app.inject({ method: 'GET', url: `/issues/${id}`, headers });
    expect(missing.statusCode).toBe(404);
  });

  it('leaves /health open and /ingest to its own secret', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const ingest = await app.inject({
      method: 'POST',
      url: '/ingest/posthog',
      headers: bearer(testConfig.posthogWebhookSecret ?? ''),
      payload: posthogWebhookFixture,
    });
    expect(ingest.statusCode).toBe(200);
    const withApiToken = await app.inject({
      method: 'POST',
      url: '/ingest/posthog',
      headers: bearer(testConfig.apiToken ?? ''),
      payload: posthogWebhookFixture,
    });
    expect(withApiToken.statusCode).toBe(401);
  });

  it("takes only the node's secret on a run's knowledge routes", async () => {
    const url = `/kg/runs/${id}/search`;
    const payload = { query: 'cart' };
    const withApiToken = await app.inject({
      method: 'POST',
      url,
      headers: bearer(testConfig.apiToken ?? ''),
      payload,
    });
    expect(withApiToken.statusCode).toBe(401);
    // Past the guard: no issue has this run, so it is refused for that.
    const withSecret = await app.inject({
      method: 'POST',
      url,
      headers: bearer(testConfig.nodeSharedSecret ?? ''),
      payload,
    });
    expect(withSecret.statusCode).toBe(403);
  });

  it('answers 404 on the GitHub webhook while GitHub is not set up', async () => {
    const res = await app.inject({ method: 'POST', url: '/ingest/github', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("hands GitHub tokens only to a node with the node's secret", async () => {
    const withApiToken = await app.inject({
      method: 'GET',
      url: '/github/token',
      headers: bearer(testConfig.apiToken ?? ''),
    });
    expect(withApiToken.statusCode).toBe(401);
    // Past the guard: no app is installed in tests.
    const withSecret = await app.inject({
      method: 'GET',
      url: '/github/token',
      headers: bearer(testConfig.nodeSharedSecret ?? ''),
    });
    expect(withSecret.statusCode).toBe(404);
  });
});
