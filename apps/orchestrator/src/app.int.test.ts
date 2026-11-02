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
    const claimed = fixJobSchema.parse(job?.data);
    expect(claimed).toMatchObject({ issueId: issue.id, fingerprint: 'int-1', tier: 1 });

    // The daemon gives up on tier 1. Its active job is cancelled, so tier 2 is claimable
    // at once, and a retry of the same escalate is refused.
    const escalate = { type: 'escalate', runId: claimed.runId, reason: 'tests still fail' };
    const url = `/issues/${issue.id}/events`;
    expect((await app.inject({ method: 'POST', url, payload: escalate })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, payload: escalate })).statusCode).toBe(409);

    const [next] = await deps.boss.fetch(FIX_QUEUE);
    expect(fixJobSchema.parse(next?.data)).toMatchObject({ issueId: issue.id, tier: 2 });
    const [tier1] = await deps.boss.findJobs(FIX_QUEUE, { id: claimed.runId });
    expect(tier1?.state).toBe('cancelled');
  });

  it('cancels a queued fix job when the issue is killed', async () => {
    const reported = await app.inject({
      method: 'POST',
      url: '/issues',
      payload: { fingerprint: 'int-2', title: 'boom' },
    });
    const { issue } = reported.json<{ issue: Issue }>();
    for (const payload of [
      { type: 'triage', class: 'frontend', severity: 'low' },
      { type: 'start_fix' },
      { type: 'kill' },
    ]) {
      await app.inject({ method: 'POST', url: `/issues/${issue.id}/events`, payload });
    }
    const jobs = await deps.boss.findJobs(FIX_QUEUE, { data: { issueId: issue.id } });
    expect(jobs.map((j) => j.state)).toEqual(['cancelled']);
    expect(await deps.boss.fetch(FIX_QUEUE)).toEqual([]);
  });

  it('reports healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
