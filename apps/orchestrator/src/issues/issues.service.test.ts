import type { IssueEvent } from '@page/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { FIX_QUEUE, type FixJob } from '../queue/fix-jobs.ts';
import { IssueNotFoundError, IssuesService, StaleRunError } from './issues.service.ts';
import { TransitionError } from './transitions.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());
const service = new IssuesService(deps.db, deps.fixJobs);

const triage: IssueEvent = { type: 'triage', class: 'backend-api', severity: 'high' };
const reason = 'tests still fail';
let n = 0;
const report = () => service.report({ fingerprint: `fp-${++n}`, title: 'TypeError in /api/cart' });

async function jobsFor(issueId: string) {
  const jobs = await deps.boss.findJobs<FixJob>(FIX_QUEUE, {
    data: { issueId },
  });
  return jobs.map((j) => j.data.tier).sort();
}

/** The issue's live fix job: the one that is not cancelled. */
async function liveJob(issueId: string) {
  const jobs = await deps.boss.findJobs<FixJob>(FIX_QUEUE, { data: { issueId } });
  const live = jobs.filter((j) => j.state !== 'cancelled');
  expect(live).toHaveLength(1);
  return live[0]!;
}

/** Applies an event as the daemon would, naming the issue's current run. */
async function fromDaemon(issueId: string, event: { type: 'patch_ready' } | { type: 'escalate' }) {
  const { data } = await liveJob(issueId);
  const body: IssueEvent =
    event.type === 'escalate'
      ? { type: 'escalate', runId: data.runId, reason }
      : { type: 'patch_ready', runId: data.runId };
  return service.apply(issueId, body);
}

async function fixingIssue() {
  const { issue } = await report();
  await service.apply(issue.id, triage);
  await service.apply(issue.id, { type: 'start_fix' });
  return issue;
}

beforeEach(() => {
  n += 100;
});

describe('IssuesService', () => {
  it('opens an issue, then counts repeats of it', async () => {
    const first = await service.report({ fingerprint: 'dup', title: 'Boom' });
    expect(first.created).toBe(true);
    expect(first.issue).toMatchObject({ status: 'new', occurrences: 1, currentTier: null });

    const again = await service.report({ fingerprint: 'dup', title: 'Boom' });
    expect(again.created).toBe(false);
    expect(again.issue).toMatchObject({ id: first.issue.id, occurrences: 2 });
  });

  it('opens a new issue when a closed one recurs', async () => {
    const { issue } = await service.report({ fingerprint: 'recur', title: 'Boom' });
    await service.apply(issue.id, { type: 'kill' });
    const next = await service.report({ fingerprint: 'recur', title: 'Boom' });
    expect(next.created).toBe(true);
    expect(next.issue.id).not.toBe(issue.id);
  });

  it('queues one fix job per tier as the issue escalates', async () => {
    const { issue } = await report();
    await service.apply(issue.id, triage);
    expect(await jobsFor(issue.id)).toEqual([]);

    expect(await service.apply(issue.id, { type: 'start_fix' })).toMatchObject({ currentTier: 1 });
    await fromDaemon(issue.id, { type: 'escalate' });
    await fromDaemon(issue.id, { type: 'escalate' });
    expect(await jobsFor(issue.id)).toEqual([1, 2, 3]);
    expect((await liveJob(issue.id)).data.tier).toBe(3);

    expect(await fromDaemon(issue.id, { type: 'escalate' })).toMatchObject({ status: 'failed' });
    expect(await jobsFor(issue.id)).toEqual([1, 2, 3]);
  });

  it('cancels the replaced job when the issue escalates, so it is never retried', async () => {
    const issue = await fixingIssue();
    const tier1 = await liveJob(issue.id);
    await fromDaemon(issue.id, { type: 'escalate' });

    const [after] = await deps.boss.findJobs<FixJob>(FIX_QUEUE, { id: tier1.id });
    expect(after?.state).toBe('cancelled');
    expect((await liveJob(issue.id)).data.tier).toBe(2);
  });

  it('cancels the queued fix job when the issue is killed', async () => {
    const issue = await fixingIssue();
    await service.apply(issue.id, { type: 'kill' });
    const jobs = await deps.boss.findJobs<FixJob>(FIX_QUEUE, { data: { issueId: issue.id } });
    expect(jobs.map((j) => j.state)).toEqual(['cancelled']);
  });

  it('refuses a retried or late event from an earlier run', async () => {
    const issue = await fixingIssue();
    const { runId } = (await liveJob(issue.id)).data;
    await service.apply(issue.id, { type: 'escalate', runId, reason });

    await expect(service.apply(issue.id, { type: 'escalate', runId, reason })).rejects.toThrow(
      StaleRunError,
    );
    await expect(service.apply(issue.id, { type: 'patch_ready', runId })).rejects.toThrow(
      StaleRunError,
    );
    expect(await service.get(issue.id)).toMatchObject({ status: 'fixing', currentTier: 2 });
    expect(await jobsFor(issue.id)).toEqual([1, 2]);
  });

  it('records every applied event in order', async () => {
    const issue = await fixingIssue();
    await fromDaemon(issue.id, { type: 'patch_ready' });
    await service.apply(issue.id, { type: 'approve' });

    const events = await service.events(issue.id);
    expect(events.map((e) => [e.event.type, e.fromStatus, e.toStatus])).toEqual([
      ['triage', 'new', 'triaged'],
      ['start_fix', 'triaged', 'fixing'],
      ['patch_ready', 'fixing', 'awaiting_approval'],
      ['approve', 'awaiting_approval', 'resolved'],
    ]);
    expect(events[0]?.event).toEqual(triage);
    expect(await service.get(issue.id)).toMatchObject({
      status: 'resolved',
      class: 'backend-api',
      severity: 'high',
    });
  });

  it('leaves nothing behind when an event does not apply', async () => {
    const { issue } = await report();
    await expect(service.apply(issue.id, { type: 'approve' })).rejects.toThrow(TransitionError);
    expect(await service.events(issue.id)).toEqual([]);
    expect((await service.get(issue.id)).status).toBe('new');
  });

  it('lists issues, optionally by status', async () => {
    const { issue } = await report();
    await service.apply(issue.id, triage);
    const triaged = await service.list('triaged');
    expect(triaged.map((i) => i.id)).toContain(issue.id);
    expect(triaged.every((i) => i.status === 'triaged')).toBe(true);
    expect((await service.list()).length).toBeGreaterThan(triaged.length);
  });

  it('reports missing issues', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    await expect(service.get(id)).rejects.toThrow(IssueNotFoundError);
    await expect(service.events(id)).rejects.toThrow(IssueNotFoundError);
    await expect(service.apply(id, { type: 'kill' })).rejects.toThrow(IssueNotFoundError);
  });
});
