import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { KnowledgeService, runBranch } from '../knowledge/knowledge.service.ts';
import { HashEmbedder } from '@page/model-client';
import type { GitHubApi } from './github-api.ts';
import { GitHubReviewService, type PullRequestPayload } from './github-review.service.ts';
import { signedByGitHub } from './github-webhook.controller.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger);
const knowledge = new KnowledgeService(deps.db, new HashEmbedder(), deps.logger, deps.config);

class FakeGitHubApi implements GitHubApi {
  closed: { pr: number; comment: string }[] = [];
  reviewComments() {
    return Promise.resolve([
      { author: 'ana', path: 'src/cart.ts', line: 12, body: 'Cap it at 99, not 100.' },
    ]);
  }
  issueComments() {
    return Promise.resolve([{ author: 'ana', body: 'Also add a test for zero.' }]);
  }
  close(pr: number, comment: string) {
    this.closed.push({ pr, comment });
    return Promise.resolve();
  }
  head() {
    return Promise.resolve('c'.repeat(40));
  }
  files() {
    return Promise.resolve([]);
  }
  text() {
    return Promise.resolve('');
  }
}

let n = 0;
/** An issue whose Tier 1 fix is waiting on review. Returns its run id. */
async function awaitingReview() {
  const { issue } = await issues.report(
    { fingerprint: `review-${++n}`, title: 'Boom' },
    'Error: boom',
  );
  await issues.apply(issue.id, { type: 'triage', class: 'backend-api', severity: 'high' });
  const fixing = await issues.apply(issue.id, { type: 'start_fix' });
  const runId = (
    await deps.db
      .selectFrom('issues')
      .select('current_run_id')
      .where('id', '=', fixing.id)
      .executeTakeFirstOrThrow()
  ).current_run_id!;
  await issues.apply(issue.id, { type: 'patch_ready', runId });
  return { issueId: issue.id, runId };
}

const payload = (runId: string, extra: Partial<PullRequestPayload> = {}): PullRequestPayload => ({
  action: 'closed',
  pull_request: {
    number: 7,
    html_url: 'https://github.com/o/r/pull/7',
    merged: true,
    merge_commit_sha: 'd'.repeat(40),
    head: { ref: `pageagents/${runId}` },
  },
  sender: { login: 'ana' },
  ...extra,
});

describe('GitHubReviewService', () => {
  it('approves the fix when its PR is merged, and copies its knowledge to main', async () => {
    const github = new FakeGitHubApi();
    const reviews = new GitHubReviewService(deps.db, github, deps.logger, issues, knowledge);
    const { issueId, runId } = await awaitingReview();
    await knowledge.writeNode(
      runBranch(runId),
      { key: 'file:reviewed.ts', kind: 'file', title: 'Reviewed', body: '' },
      { runId, author: 'agent:tier1' },
    );

    expect(await reviews.handle('pull_request', payload(runId))).toEqual({
      kind: 'approved',
      issueId,
    });
    expect((await issues.get(issueId)).status).toBe('resolved');
    const events = await issues.events(issueId);
    expect(events.at(-1)).toMatchObject({ event: { type: 'approve' }, actor: 'github:ana' });
    const { versions } = await knowledge.node('main', 'file:reviewed.ts');
    expect(versions[0]?.commitSha).toBe('d'.repeat(40));
  });

  it('rejects on changes requested, hands the review to the next tier, and closes the PR', async () => {
    const github = new FakeGitHubApi();
    const reviews = new GitHubReviewService(deps.db, github, deps.logger, issues, knowledge);
    const { issueId, runId } = await awaitingReview();

    const outcome = await reviews.handle(
      'pull_request_review',
      payload(runId, {
        action: 'submitted',
        review: {
          id: 3,
          state: 'changes_requested',
          body: 'Close, but not quite.',
          user: { login: 'ana' },
        },
      }),
    );
    expect(outcome).toEqual({ kind: 'rejected', issueId });
    const issue = await issues.get(issueId);
    expect(issue).toMatchObject({ status: 'fixing', currentTier: 2 });
    const [job] = (
      await deps.boss.findJobs<{
        issueId: string;
        tier: number;
        escalationNote?: { blocker: string };
      }>('fix', { data: { issueId } })
    ).filter((j) => j.state !== 'cancelled' && j.data.tier === 2);
    expect(job?.data.escalationNote?.blocker).toContain('Close, but not quite.');
    expect(job?.data.escalationNote?.blocker).toContain(
      'src/cart.ts:12 (@ana): Cap it at 99, not 100.',
    );
    expect(job?.data.escalationNote?.blocker).toContain('@ana: Also add a test for zero.');
    expect(github.closed).toMatchObject([{ pr: 7 }]);
    expect(github.closed[0]?.comment).toContain('Tier 2');
  });

  it('rejects a PR closed without merging, and leaves it closed', async () => {
    const github = new FakeGitHubApi();
    const reviews = new GitHubReviewService(deps.db, github, deps.logger, issues, knowledge);
    const { issueId, runId } = await awaitingReview();
    const closed = payload(runId);
    closed.pull_request.merged = false;

    expect(await reviews.handle('pull_request', closed)).toEqual({ kind: 'rejected', issueId });
    expect((await issues.get(issueId)).currentTier).toBe(2);
    expect(github.closed).toEqual([]);
  });

  it('ignores a PR that is not an agent branch, or whose run is not current', async () => {
    const reviews = new GitHubReviewService(deps.db, null, deps.logger, issues, knowledge);
    const other = payload(randomUUID());
    expect((await reviews.handle('pull_request', other)).kind).toBe('ignored');
    const human = payload(randomUUID());
    human.pull_request.head.ref = 'feature/x';
    expect(await reviews.handle('pull_request', human)).toEqual({
      kind: 'ignored',
      why: 'not an agent branch',
    });
  });
});

describe('signedByGitHub', () => {
  it("accepts GitHub's HMAC of the raw body and nothing else", () => {
    const body = Buffer.from('{"a":1}');
    const secret = 's'.repeat(20);
    const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(signedByGitHub(body, good, secret)).toBe(true);
    expect(signedByGitHub(body, good, 'x'.repeat(20))).toBe(false);
    expect(signedByGitHub(Buffer.from('{"a":2}'), good, secret)).toBe(false);
    expect(signedByGitHub(body, undefined, secret)).toBe(false);
  });
});
