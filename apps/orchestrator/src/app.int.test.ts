import { fixJobSchema, type Issue } from '@page/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { createSchemaDeps } from './db/test-utils.ts';
import { FIX_QUEUE } from './queue/fix-jobs.ts';

const deps = await createSchemaDeps();
const app = await createApp(deps, false);
await app.init();
await app.getHttpAdapter().getInstance().ready();
afterAll(async () => {
  await app.close();
  await deps.close();
});

describe('orchestrator on real Postgres', () => {
  it('queues a fix job that a node daemon can claim', async () => {
    const reported = await app.inject({
      method: 'POST',
      url: '/issues',
      payload: { fingerprint: 'int-1', title: 'relation "orders" does not exist' },
    });
    const { issue } = reported.json<{ issue: Issue }>();

    for (const payload of [
      { type: 'triage', class: 'database', severity: 'critical' },
      { type: 'start_fix' },
    ]) {
      const res = await app.inject({ method: 'POST', url: `/issues/${issue.id}/events`, payload });
      expect(res.statusCode).toBe(200);
    }

    // What apps/node will do: claim the next job and read it through the shared contract.
    const [job] = await deps.boss.fetch(FIX_QUEUE);
    expect(fixJobSchema.parse(job?.data)).toMatchObject({
      issueId: issue.id,
      fingerprint: 'int-1',
      tier: 1,
    });
  });

  it('reports healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
