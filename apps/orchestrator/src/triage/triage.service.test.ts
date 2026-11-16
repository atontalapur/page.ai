import { notifyJobSchema } from '@page/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { NOTIFY_QUEUE } from '../queue/queues.ts';
import { TriageClassifier } from './classify.ts';
import { TriageService } from './triage.service.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger);
const triageClassifier = new TriageClassifier(null, 1000);
const triage = new TriageService(issues, deps.jobs, triageClassifier, deps.config, deps.logger);

describe('TriageService', () => {
  it('moves a new issue to triaged and enqueues one notify job per phone', async () => {
    const { issue } = await issues.report({
      fingerprint: 'hydrate',
      title: 'Hydration failed',
    });
    await triage.handle({ v: 1, issueId: issue.id });
    await triage.handle({ v: 1, issueId: issue.id });

    expect(await issues.get(issue.id)).toMatchObject({
      status: 'triaged',
      class: 'frontend',
      severity: 'medium',
    });
    const jobs = await deps.boss.findJobs(NOTIFY_QUEUE, { data: { issueId: issue.id } });
    expect(jobs).toHaveLength(1);
    const payload = notifyJobSchema.parse(jobs[0]?.data);
    expect(payload).toMatchObject({ v: 2, issueId: issue.id, channel: 'call', to: '+15550000001' });
    expect(payload.message).toContain('medium frontend');
    expect(payload.message).toContain(`/issues/${issue.id}`);
    expect(jobs[0]?.singletonKey).toBe('hydrate:+15550000001');
  });

  it('queues a separate job for each phone, keyed by fingerprint and phone', async () => {
    const numbers = ['+15550000001', '+15550000002'];
    const config = { ...deps.config, notifyTo: numbers };
    const twoPhones = new TriageService(issues, deps.jobs, triageClassifier, config, deps.logger);
    const { issue } = await issues.report({ fingerprint: 'two-phones', title: 'Boom' });
    await twoPhones.handle({ v: 1, issueId: issue.id });

    const jobs = await deps.boss.findJobs(NOTIFY_QUEUE, { data: { issueId: issue.id } });
    const sent = jobs.map((job) => notifyJobSchema.parse(job.data).to).sort();
    expect(sent).toEqual(numbers);
    expect(jobs.map((job) => job.singletonKey).sort()).toEqual(
      numbers.map((to) => `two-phones:${to}`),
    );
  });

  it('triages without paging when no numbers are configured', async () => {
    const config = { ...deps.config, notifyTo: [] };
    const noPhones = new TriageService(issues, deps.jobs, triageClassifier, config, deps.logger);
    const { issue } = await issues.report({ fingerprint: 'no-phones', title: 'Boom' });
    await noPhones.handle({ v: 1, issueId: issue.id });

    expect((await issues.get(issue.id)).status).toBe('triaged');
    expect(await deps.boss.findJobs(NOTIFY_QUEUE, { data: { issueId: issue.id } })).toEqual([]);
  });
});
