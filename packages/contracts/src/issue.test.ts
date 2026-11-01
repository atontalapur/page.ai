import { describe, expect, it } from 'vitest';
import { fixJob } from './fix-job.ts';
import { issueEvent, newIssue } from './issue.ts';

describe('contracts', () => {
  it('trims and bounds a new issue', () => {
    expect(newIssue.parse({ fingerprint: ' fp ', title: ' Boom ' })).toEqual({
      fingerprint: 'fp',
      title: 'Boom',
    });
    expect(newIssue.safeParse({ fingerprint: '', title: 'Boom' }).success).toBe(false);
  });

  it('accepts known events and rejects unknown ones', () => {
    expect(
      issueEvent.parse({ type: 'triage', category: 'database', severity: 'high' }),
    ).toMatchObject({ type: 'triage' });
    expect(issueEvent.safeParse({ type: 'escalate' }).success).toBe(false);
    expect(issueEvent.safeParse({ type: 'deploy' }).success).toBe(false);
  });

  it('only allows tiers 1 to 3 on a fix job', () => {
    const issueId = '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60';
    expect(fixJob.safeParse({ issueId, tier: 3 }).success).toBe(true);
    expect(fixJob.safeParse({ issueId, tier: 4 }).success).toBe(false);
    expect(fixJob.safeParse({ issueId, tier: 1.5 }).success).toBe(false);
  });
});
