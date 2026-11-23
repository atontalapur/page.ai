import { Inject, Injectable } from '@nestjs/common';
import { clip, MAX_REASON_CHARS, type EscalationNote } from '@page/contracts';
import type { Db } from '../db/database.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { KnowledgeService, runBranch } from '../knowledge/knowledge.service.ts';
import type { Logger } from '../logger.ts';
import { DB, LOGGER } from '../tokens.ts';
import { GitHubAppService } from './github-app.service.ts';
import { PrAnswersService, type AskedIn } from './pr-answers.service.ts';

// The branch every agent pushes its fix to, as GitHubHostTools names it.
const AGENT_BRANCH = /^pageagents\/([0-9a-f-]{36})$/;
// The most of a review's text the next tier gets in its note.
const MAX_FEEDBACK_CHARS = 8_000;
// A line in a comment, or a Comment review, that decides like the review buttons. For a PR
// whose author is the reviewer, which GitHub won't let approve or request changes.
const COMMAND = /^\s*\/(approve|reject)\b/im;

/** The parts of GitHub's webhook payloads this reads. */
export interface PullRequestPayload {
  action: string;
  number?: number;
  pull_request: {
    number: number;
    html_url: string;
    merged: boolean;
    merge_commit_sha: string | null;
    head: { ref: string };
  };
  review?: { id: number; state: string; body: string | null; user: { login: string } | null };
  /** A pull_request_review_comment event's inline comment. */
  comment?: { id: number; body: string | null; user: { login: string } | null };
  sender?: { login: string };
}

/** An issue_comment event's payload: the PR is named by number alone. */
export interface IssueCommentPayload {
  action: string;
  issue: { number: number; html_url: string; pull_request?: unknown };
  comment: { body: string | null; user: { login: string } | null };
  sender?: { login: string };
}

export type ReviewOutcome =
  | { kind: 'ignored'; why: string }
  | { kind: 'asked' }
  | { kind: 'approved'; issueId: string }
  | { kind: 'rejected'; issueId: string };

/**
 * Turns what a reviewer does on a fix's PR into the issue's decision: a merge approves the
 * fix, and "changes requested" or a close without merging rejects it. A rejection carries
 * the review, its inline comments and the PR's conversation to the next tier as its
 * escalation note, so the next agent works from the reviewer's words. A merge also copies
 * the run's knowledge onto main, with the merge commit.
 *
 * Only a PR from the issue's current run decides anything; an older PR, or one whose issue
 * has moved on, is ignored.
 */
@Injectable()
export class GitHubReviewService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly github: GitHubAppService,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly issues: IssuesService,
    private readonly knowledge: KnowledgeService,
    private readonly answers: PrAnswersService,
  ) {}

  /** The answer being written for the last question, for tests to wait on. */
  answering: Promise<unknown> = Promise.resolve();

  async handle(event: string, payload: PullRequestPayload): Promise<ReviewOutcome> {
    const runId = AGENT_BRANCH.exec(payload.pull_request.head.ref)?.[1];
    if (runId === undefined) return { kind: 'ignored', why: 'not an agent branch' };

    if (event === 'pull_request' && payload.action === 'closed') {
      return payload.pull_request.merged
        ? this.merged(runId, payload)
        : this.rejected(runId, payload, 'closed', null);
    }
    if (event === 'pull_request_review' && payload.action === 'submitted' && payload.review) {
      const { state, body } = payload.review;
      const command = COMMAND.exec(body ?? '')?.[1];
      if (state === 'changes_requested' || command === 'reject') {
        return this.rejected(runId, payload, 'changes_requested', payload.review);
      }
      if (state === 'approved' || command === 'approve') return this.approved(runId, payload);
      if (body?.trim()) {
        const author = payload.review.user?.login ?? 'unknown';
        return this.ask(runId, payload.pull_request.number, author, body, { kind: 'conversation' });
      }
    }
    if (
      event === 'pull_request_review_comment' &&
      payload.action === 'created' &&
      payload.comment
    ) {
      const { id, body, user } = payload.comment;
      if (!body?.trim()) return { kind: 'ignored', why: 'an empty comment' };
      return this.ask(runId, payload.pull_request.number, user?.login ?? 'unknown', body, {
        kind: 'review_thread',
        commentId: id,
      });
    }
    return { kind: 'ignored', why: `${event} ${payload.action} decides nothing` };
  }

  /**
   * A comment on the PR's conversation with /approve or /reject. The payload names the PR by
   * number, so its branch is looked up to find the run.
   */
  async handleComment(payload: IssueCommentPayload): Promise<ReviewOutcome> {
    if (payload.action !== 'created' || !payload.issue.pull_request) {
      return { kind: 'ignored', why: 'not a new comment on a PR' };
    }
    const api = await this.github.api();
    if (!api) return { kind: 'ignored', why: 'GitHub is not set up' };
    const ref = await api.headRef(payload.issue.number);
    const command = COMMAND.exec(payload.comment.body ?? '')?.[1];
    if (!command) {
      const runId = AGENT_BRANCH.exec(ref)?.[1];
      const body = payload.comment.body ?? '';
      if (runId === undefined || !body.trim())
        return { kind: 'ignored', why: 'not a question for an agent PR' };
      const author = payload.comment.user?.login ?? 'unknown';
      return this.ask(runId, payload.issue.number, author, body, { kind: 'conversation' });
    }
    const pr: PullRequestPayload = {
      action: 'submitted',
      pull_request: {
        number: payload.issue.number,
        html_url: payload.issue.html_url,
        merged: false,
        merge_commit_sha: null,
        head: { ref },
      },
      review: {
        id: 0,
        state: 'commented',
        body: payload.comment.body,
        user: payload.comment.user,
      },
      ...(payload.sender ? { sender: payload.sender } : {}),
    };
    return this.handle('pull_request_review', pr);
  }

  /**
   * A comment that may be a question for the agent. jev decides; a question is answered in
   * the background, since GitHub waits only ten seconds for the webhook. The bot's own
   * comments are never answered, so it can't talk to itself.
   */
  private ask(
    runId: string,
    pr: number,
    author: string,
    text: string,
    where: AskedIn,
  ): ReviewOutcome {
    if (author.endsWith('[bot]')) return { kind: 'ignored', why: "the bot's own comment" };
    this.answering = (async () => {
      const run = await this.db
        .selectFrom('runs')
        .select('id')
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!run || !(await this.answers.isQuestion(text))) return;
      await this.answers.answer({ pr, runId, author, text, where });
    })().catch((error: unknown) => {
      this.logger.warn({ err: error, pr }, 'could not answer a PR comment');
    });
    return { kind: 'asked' };
  }

  /** An approving review: the fix is accepted, though the PR may be merged later. */
  private async approved(runId: string, payload: PullRequestPayload): Promise<ReviewOutcome> {
    const by = payload.review?.user?.login ?? payload.sender?.login ?? 'unknown';
    const issue = await this.awaiting(runId);
    if (!issue) return { kind: 'ignored', why: 'the run is not awaiting review' };
    await this.issues.apply(issue.id, { type: 'approve' }, { actor: `github:${by}` });
    this.logger.info(
      { issueId: issue.id, runId, pr: payload.pull_request.html_url },
      'PR approved',
    );
    return { kind: 'approved', issueId: issue.id };
  }

  private async merged(runId: string, payload: PullRequestPayload): Promise<ReviewOutcome> {
    const by = payload.sender?.login ?? 'unknown';
    const sha = payload.pull_request.merge_commit_sha;
    // The run's knowledge goes to main even if the issue moved on: the code it describes is
    // on main now.
    if (sha) await this.knowledge.promote(runBranch(runId), sha, `github:${by}`);
    const issue = await this.awaiting(runId);
    if (!issue) return { kind: 'ignored', why: 'the run is not awaiting review' };
    await this.issues.apply(issue.id, { type: 'approve' }, { actor: `github:${by}` });
    this.logger.info({ issueId: issue.id, runId, pr: payload.pull_request.html_url }, 'PR merged');
    return { kind: 'approved', issueId: issue.id };
  }

  private async rejected(
    runId: string,
    payload: PullRequestPayload,
    how: 'closed' | 'changes_requested',
    review: PullRequestPayload['review'] | null,
  ): Promise<ReviewOutcome> {
    const issue = await this.awaiting(runId);
    if (!issue) return { kind: 'ignored', why: 'the run is not awaiting review' };
    const pr = payload.pull_request.number;
    const by = review?.user?.login ?? payload.sender?.login ?? 'unknown';
    const feedback = await this.feedback(pr, review ?? null);
    const verb = how === 'closed' ? 'closed it without merging' : 'requested changes';
    const reason = clip(
      `@${by} ${verb} on PR #${pr}.${feedback ? `\n\n${feedback}` : ''}`,
      MAX_REASON_CHARS,
    );
    const note: EscalationNote = {
      summary: `A reviewer rejected the Tier ${issue.current_tier ?? '?'} fix: @${by} ${verb} on PR #${pr}.`,
      tried: [],
      blocker: clip(feedback || `@${by} ${verb} without a comment.`, MAX_FEEDBACK_CHARS),
    };
    await this.issues.apply(
      issue.id,
      { type: 'reject', reason },
      { actor: `github:${by}`, escalationNote: note },
    );
    // The next tier opens its own PR; this one would only sit beside it.
    const api = await this.github.api();
    if (how === 'changes_requested' && api) {
      const next = (issue.current_tier ?? 0) + 1;
      await api
        .close(
          pr,
          next > 3
            ? 'PageAgents closed this PR: changes were requested and no tier is left, so a person takes over.'
            : `PageAgents closed this PR: changes were requested, so Tier ${next} takes the fix from here, starting from this review.`,
        )
        .catch((error: unknown) => {
          this.logger.warn({ err: error, pr }, 'could not close the rejected PR');
        });
    }
    this.logger.info({ issueId: issue.id, runId, pr, how }, 'PR rejected');
    return { kind: 'rejected', issueId: issue.id };
  }

  /** The review's text, its inline comments, and the PR's conversation, as the next tier reads it. */
  private async feedback(pr: number, review: PullRequestPayload['review'] | null): Promise<string> {
    const parts: string[] = [];
    const text = review?.body?.replace(COMMAND, '').trim();
    if (text) parts.push(`Review:\n${text}`);
    const api = await this.github.api();
    if (api) {
      try {
        if (review && review.id !== 0) {
          const inline = await api.reviewComments(pr, review.id);
          if (inline.length > 0) {
            parts.push(
              `Comments on the code:\n${inline
                .map(
                  (c) =>
                    `- ${c.path}${c.line === null ? '' : `:${c.line}`} (@${c.author}): ${c.body.trim()}`,
                )
                .join('\n')}`,
            );
          }
        }
        const conversation = (await api.issueComments(pr)).filter((c) => c.body.trim());
        if (conversation.length > 0) {
          parts.push(
            `Conversation:\n${conversation.map((c) => `- @${c.author}: ${c.body.trim()}`).join('\n')}`,
          );
        }
      } catch (error) {
        this.logger.warn({ err: error, pr }, 'could not read the PR comments');
      }
    }
    return parts.join('\n\n');
  }

  /** The issue whose current run is `runId` and whose fix waits on a reviewer. */
  private async awaiting(runId: string) {
    return this.db
      .selectFrom('issues')
      .select(['id', 'status', 'current_tier'])
      .where('current_run_id', '=', runId)
      .where('status', 'in', ['awaiting_approval', 'pr_open'])
      .executeTakeFirst();
  }
}
