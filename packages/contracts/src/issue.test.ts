import { describe, expect, it } from 'vitest';
import { issueEventSchema, newIssueSchema } from './issue.ts';

describe('issue contracts', () => {
  it('trims and bounds a new issue', () => {
    expect(newIssueSchema.parse({ fingerprint: ' fp ', title: ' Boom ' })).toEqual({
      fingerprint: 'fp',
      title: 'Boom',
    });
    expect(newIssueSchema.safeParse({ fingerprint: '', title: 'Boom' }).success).toBe(false);
    expect(newIssueSchema.safeParse({ fingerprint: '  ', title: 'Boom' }).success).toBe(false);
  });

  it('accepts known events and rejects unknown ones', () => {
    expect(
      issueEventSchema.parse({ type: 'triage', class: 'database', severity: 'high' }),
    ).toMatchObject({ type: 'triage' });
    expect(
      issueEventSchema.safeParse({ type: 'triage', class: 'backend', severity: 'high' }).success,
    ).toBe(false);
    expect(issueEventSchema.safeParse({ type: 'escalate' }).success).toBe(false);
    expect(issueEventSchema.safeParse({ type: 'escalate', reason: 'x' }).success).toBe(false);
    expect(issueEventSchema.safeParse({ type: 'patch_ready' }).success).toBe(false);
    expect(
      issueEventSchema.safeParse({
        type: 'patch_ready',
        runId: '7f6c2c1e-3d5b-4f0a-9a43-1c2b3d4e5f60',
      }).success,
    ).toBe(true);
    expect(issueEventSchema.safeParse({ type: 'deploy' }).success).toBe(false);
  });
});
