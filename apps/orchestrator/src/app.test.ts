import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { issueRunSchema, type Issue } from '@page/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { createTestDeps, testConfig } from './db/test-utils.ts';

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(deps, false);
await app.init();
await app.getHttpAdapter().getInstance().ready();
afterAll(async () => {
  await app.close();
  await deps.close();
});

const headers = { authorization: `Bearer ${testConfig.apiToken ?? ''}` };
const http = (method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers });

describe('orchestrator HTTP API', () => {
  it('reports healthy', async () => {
    const res = await http('GET', '/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('runs an issue through its lifecycle', async () => {
    const created = await http('POST', '/issues', { fingerprint: 'http-1', title: 'Boom' });
    expect(created.statusCode).toBe(201);
    const { issue } = created.json<{ issue: Issue; created: boolean }>();

    const triaged = await http('POST', `/issues/${issue.id}/events`, {
      type: 'triage',
      class: 'frontend',
      severity: 'low',
    });
    expect(triaged.statusCode).toBe(200);
    expect(triaged.json<Issue>().status).toBe('triaged');

    const fixing = await http('POST', `/issues/${issue.id}/events`, { type: 'start_fix' });
    expect(fixing.json<Issue>()).toMatchObject({ status: 'fixing', currentTier: 1 });

    expect((await http('GET', `/issues/${issue.id}`)).json<Issue>().currentTier).toBe(1);
    expect((await http('GET', `/issues/${issue.id}/events`)).json()).toHaveLength(2);
    // The fix job is queued and no daemon has claimed it, so its run has no steps yet.
    const runs = await http('GET', `/issues/${issue.id}/runs`);
    expect(runs.statusCode).toBe(200);
    expect(issueRunSchema.array().parse(runs.json())).toMatchObject([
      { tier: 1, status: 'queued', steps: [] },
    ]);
    const listed = await http('GET', '/issues?status=fixing');
    expect(listed.json<Issue[]>().map((i) => i.id)).toContain(issue.id);
  });

  it('rejects invalid input with 400', async () => {
    expect((await http('POST', '/issues', { title: 'no fingerprint' })).statusCode).toBe(400);
    expect((await http('GET', '/issues/not-a-uuid')).statusCode).toBe(400);
    expect((await http('GET', '/issues?status=done')).statusCode).toBe(400);

    const { issue } = (await http('POST', '/issues', { fingerprint: 'http-2', title: 'x' })).json<{
      issue: Issue;
    }>();
    const bad = await http('POST', `/issues/${issue.id}/events`, { type: 'escalate' });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses run outcomes, which only the run_finished queue applies', async () => {
    const { issue } = (
      await http('POST', '/issues', { fingerprint: 'http-run', title: 'x' })
    ).json<{
      issue: Issue;
    }>();
    await http('POST', `/issues/${issue.id}/events`, {
      type: 'triage',
      class: 'frontend',
      severity: 'low',
    });
    const fixing = (
      await http('POST', `/issues/${issue.id}/events`, { type: 'start_fix' })
    ).json<Issue>();
    expect(fixing.status).toBe('fixing');

    const runId = '00000000-0000-4000-8000-000000000001';
    for (const event of [
      { type: 'patch_ready', runId },
      { type: 'ops_fixed', runId },
      { type: 'escalate', runId, reason: 'stuck' },
      { type: 'fail', runId, reason: 'sandbox' },
    ]) {
      const res = await http('POST', `/issues/${issue.id}/events`, event);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe(
        `${event.type} comes from the node daemon's run_finished job, not this route`,
      );
    }
    expect((await http('GET', `/issues/${issue.id}`)).json<Issue>().status).toBe('fixing');
  });

  it('refuses a fix started on an agent that is not connected, and queues nothing', async () => {
    const created = await http('POST', '/issues', { fingerprint: 'http-node', title: 'Boom' });
    const { issue } = created.json<{ issue: Issue }>();
    await http('POST', `/issues/${issue.id}/events`, {
      type: 'triage',
      class: 'frontend',
      severity: 'low',
    });

    const res = await http('POST', `/issues/${issue.id}/events`, {
      type: 'start_fix',
      node: 'nowhere-1',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toBe('agent nowhere-1 is not connected');
    expect((await http('GET', `/issues/${issue.id}`)).json<Issue>().status).toBe('triaged');
  });

  it('maps missing issues to 404 and disallowed events to 409', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await http('GET', `/issues/${missing}`)).statusCode).toBe(404);
    expect((await http('GET', `/issues/${missing}/events`)).statusCode).toBe(404);
    expect((await http('GET', `/issues/${missing}/runs`)).statusCode).toBe(404);

    const { issue } = (await http('POST', '/issues', { fingerprint: 'http-3', title: 'x' })).json<{
      issue: Issue;
    }>();
    const conflict = await http('POST', `/issues/${issue.id}/events`, { type: 'approve' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ message: string }>().message).toBe(
      'cannot approve an issue that is new',
    );
  });
});
