import { FIX_JOB_QUEUE, type IssueEvent } from '@page/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { IssueNotFoundError, IssuesService } from './issues.service.ts';
import { TransitionError } from './transitions.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());
const service = new IssuesService(deps.db, deps.fixJobs);

const triage: IssueEvent = { type: 'triage', category: 'backend', severity: 'high' };
const escalate: IssueEvent = { type: 'escalate', reason: 'tests still fail' };
let n = 0;
const report = () => service.report({ fingerprint: `fp-${++n}`, title: 'TypeError in /api/cart' });

async function jobsFor(issueId: string) {
  const jobs = await deps.boss.findJobs<{ issueId: string; tier: number }>(FIX_JOB_QUEUE, {
    data: { issueId },
  });
  return jobs.map((j) => j.data.tier).sort();
}

beforeEach(() => {
  n += 100;
});

describe('IssuesService', () => {
  it('opens an issue, then counts repeats of it', async () => {
    const first = await service.report({ fingerprint: 'dup', title: 'Boom' });
    expect(first.created).toBe(true);
    expect(first.issue).toMatchObject({ status: 'detected', occurrences: 1, tier: null });

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

    expect(await service.apply(issue.id, { type: 'start_fix' })).toMatchObject({ tier: 1 });
    await service.apply(issue.id, escalate);
    await service.apply(issue.id, escalate);
    expect(await jobsFor(issue.id)).toEqual([1, 2, 3]);

    expect(await service.apply(issue.id, escalate)).toMatchObject({ status: 'unresolved' });
    expect(await jobsFor(issue.id)).toEqual([1, 2, 3]);
  });

  it('records every applied event in order', async () => {
    const { issue } = await report();
    await service.apply(issue.id, triage);
    await service.apply(issue.id, { type: 'start_fix' });
    await service.apply(issue.id, { type: 'patch_ready' });
    await service.apply(issue.id, { type: 'approve' });

    const events = await service.events(issue.id);
    expect(events.map((e) => [e.event.type, e.fromStatus, e.toStatus])).toEqual([
      ['triage', 'detected', 'triaged'],
      ['start_fix', 'triaged', 'fixing'],
      ['patch_ready', 'fixing', 'awaiting_approval'],
      ['approve', 'awaiting_approval', 'resolved'],
    ]);
    expect(events[0]?.event).toEqual(triage);
    expect(await service.get(issue.id)).toMatchObject({
      status: 'resolved',
      category: 'backend',
      severity: 'high',
    });
  });

  it('leaves nothing behind when an event does not apply', async () => {
    const { issue } = await report();
    await expect(service.apply(issue.id, { type: 'approve' })).rejects.toThrow(TransitionError);
    expect(await service.events(issue.id)).toEqual([]);
    expect((await service.get(issue.id)).status).toBe('detected');
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
