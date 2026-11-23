import { HashEmbedder, type ModelClient } from '@page/model-client';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { KnowledgeService } from '../knowledge/knowledge.service.ts';
import type { GitHubApi } from './github-api.ts';
import { GitHubAppService } from './github-app.service.ts';
import { GitHubReviewService } from './github-review.service.ts';
import { PrAnswersService } from './pr-answers.service.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());
const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger);
const knowledge = new KnowledgeService(deps.db, new HashEmbedder(), deps.logger, deps.config);

/** The demo repo: the PR's branch, and every comment posted. */
function repo(ref: string) {
  const posted: { pr: number; body: string; thread?: number }[] = [];
  const github = {
    headRef: () => Promise.resolve(ref),
    comment: (pr: number, body: string) => (posted.push({ pr, body }), Promise.resolve()),
    replyToReviewComment: (pr: number, thread: number, body: string) => (
      posted.push({ pr, body, thread }),
      Promise.resolve()
    ),
    reviewComments: () => Promise.resolve([]),
    issueComments: () => Promise.resolve([]),
  } as unknown as GitHubApi;
  return { github, posted };
}

/** A model that answers from what it was shown, so the test can check it saw the run. */
function model(): ModelClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete(messages) {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return Promise.resolve({
        ok: true,
        completion: {
          content:
            'It casts the slug to text in `src/shop/products.ts:41`, so the lookup compares like with like.',
          finishReason: 'stop',
          model: 'test',
          costUsd: 0,
        },
      });
    },
  };
}

let n = 0;
async function finishedRun() {
  const { issue } = await issues.report(
    { fingerprint: `ask-${++n}`, title: 'operator does not exist' },
    'error: operator does not exist: text = integer',
  );
  await issues.apply(issue.id, { type: 'triage', class: 'database', severity: 'high' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const { current_run_id: runId } = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', issue.id)
    .executeTakeFirstOrThrow();
  await deps.db
    .insertInto('runs')
    .values({
      id: runId!,
      issue_id: issue.id,
      tier: 1,
      status: 'succeeded',
      started_at: new Date(),
      finished_at: new Date(),
      pr_url: 'https://github.com/o/r/pull/9',
      confidence: null,
      diff: '-  where id = $1\n+  where id::text = $1',
    })
    .execute();
  return runId!;
}

function services(github: GitHubApi, answerer: ModelClient | null) {
  const access = new GitHubAppService(deps.db, deps.config, deps.logger, github);
  const answers = new PrAnswersService(deps.db, null, answerer, deps.logger, access, knowledge);
  return new GitHubReviewService(deps.db, access, deps.logger, issues, knowledge, answers);
}

describe('answering questions on the PR', () => {
  it('answers a question in the conversation, from the run it can see', async () => {
    const runId = await finishedRun();
    const { github, posted } = repo(`pageagents/${runId}`);
    const answerer = model();
    const reviews = services(github, answerer);

    const outcome = await reviews.handleComment({
      action: 'created',
      issue: { number: 9, html_url: 'https://github.com/o/r/pull/9', pull_request: {} },
      comment: { body: 'Why does casting to text fix it?', user: { login: 'ana' } },
    });
    await reviews.answering;

    expect(outcome).toEqual({ kind: 'asked' });
    expect(answerer.prompts[0]).toContain('operator does not exist');
    expect(answerer.prompts[0]).toContain('where id::text = $1');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain('> Why does casting to text fix it?');
    expect(posted[0]?.body).toContain('src/shop/products.ts:41');
  });

  it('replies in the thread of an inline review comment', async () => {
    const runId = await finishedRun();
    const { github, posted } = repo(`pageagents/${runId}`);
    const reviews = services(github, model());
    await reviews.handle('pull_request_review_comment', {
      action: 'created',
      pull_request: {
        number: 9,
        html_url: 'u',
        merged: false,
        merge_commit_sha: null,
        head: { ref: `pageagents/${runId}` },
      },
      comment: { id: 55, body: 'Is this safe for numeric slugs?', user: { login: 'ana' } },
    });
    await reviews.answering;
    expect(posted).toMatchObject([{ pr: 9, thread: 55 }]);
  });

  it("leaves feedback, and the bot's own comments, unanswered", async () => {
    const runId = await finishedRun();
    const { github, posted } = repo(`pageagents/${runId}`);
    const reviews = services(github, model());
    for (const [body, login] of [
      ['Please rename this helper.', 'ana'],
      ['Is this answered?', 'pageagents-1a2b[bot]'],
    ] as const) {
      await reviews.handleComment({
        action: 'created',
        issue: { number: 9, html_url: 'u', pull_request: {} },
        comment: { body, user: { login } },
      });
      await reviews.answering;
    }
    expect(posted).toEqual([]);
  });
});
