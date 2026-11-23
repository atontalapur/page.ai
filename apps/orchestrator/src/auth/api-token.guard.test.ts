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
] as const;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('API token', () => {
  it.each(routes)('$method $url returns 401 without the token or with a wrong one', async (r) => {
    for (const headers of [{}, bearer('wrong'), { authorization: testConfig.apiToken ?? '' }]) {
      const res = await app.inject({ ...r, headers });
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
});
