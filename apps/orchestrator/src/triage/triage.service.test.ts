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
const triage = new TriageService(
  issues,
  deps.jobs,
  new TriageClassifier(null, 1000),
  deps.config,
  deps.logger,
);

describe('TriageService', () => {
  it('moves a new issue to triaged and enqueues one notify job', async () => {
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
    expect(payload).toMatchObject({ v: 1, issueId: issue.id, channel: 'call' });
    expect(payload.message).toContain('medium frontend');
    expect(payload.message).toContain(`/issues/${issue.id}`);
    expect(jobs[0]?.singletonKey).toBe('hydrate');
  });
});
