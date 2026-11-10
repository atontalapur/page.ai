import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { triageJobSchema } from '@page/contracts';
import { posthogWebhookFixture } from '@page/contracts/fixtures';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { TRIAGE_QUEUE } from '../queue/queues.ts';

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(deps, false);
await app.init();
await app.getHttpAdapter().getInstance().ready();
afterAll(async () => {
  await app.close();
  await deps.close();
});

const secret = testConfig.posthogWebhookSecret ?? '';
const headers = { authorization: `Bearer ${secret}` };

describe('POST /ingest/posthog', () => {
  it('returns 401 for a bad secret, including a bad body', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/ingest/posthog',
      headers: { authorization: 'Bearer no' },
      payload: posthogWebhookFixture,
    });
    expect(bad.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'POST',
      url: '/ingest/posthog',
      payload: {},
    });
    expect(missing.statusCode).toBe(401);
  });

  it('returns 400 for a fingerprint longer than the issue column allows', async () => {
    const payload = {
      ...posthogWebhookFixture,
      event: {
        ...posthogWebhookFixture.event,
        properties: {
          ...posthogWebhookFixture.event.properties,
          $exception_issue_id: 'x'.repeat(513),
        },
      },
    };
    const res = await app.inject({ method: 'POST', url: '/ingest/posthog', headers, payload });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a body that is not an exception', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/posthog',
      headers,
      payload: { event: { ...posthogWebhookFixture.event, event: '$pageview' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('upserts one issue and queues one triage job for five identical webhooks', async () => {
    let created = false;
    let issueId = '';
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/ingest/posthog',
        headers,
        payload: posthogWebhookFixture,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ created: boolean; issue: { id: string; occurrences: number } }>();
      created = body.created;
      issueId = body.issue.id;
      expect(body.issue.occurrences).toBe(i + 1);
    }
    expect(created).toBe(false);

    const jobs = await deps.boss.findJobs(TRIAGE_QUEUE, { data: { issueId } });
    expect(jobs).toHaveLength(1);
    expect(triageJobSchema.parse(jobs[0]?.data)).toEqual({ v: 1, issueId });
    expect(jobs[0]?.singletonKey).toBe(posthogWebhookFixture.event.properties.$exception_issue_id);
  });
});
