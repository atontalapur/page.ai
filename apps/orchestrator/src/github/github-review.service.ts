import { Inject, Injectable } from '@nestjs/common';
import { clip, MAX_REASON_CHARS, type EscalationNote } from '@page/contracts';
import type { Db } from '../db/database.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { KnowledgeService, runBranch } from '../knowledge/knowledge.service.ts';
import type { Logger } from '../logger.ts';
import { DB, GITHUB, LOGGER } from '../tokens.ts';
import type { GitHubApi } from './github-api.ts';

// The branch every agent pushes its fix to, as GitHubHostTools names it.
const AGENT_BRANCH = /^pageagents\/([0-9a-f-]{36})$/;
// The most of a review's text the next tier gets in its note.
const MAX_FEEDBACK_CHARS = 8_000;

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
  sender?: { login: string };
}

export type ReviewOutcome =
  | { kind: 'ignored'; why: string }
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
    @Inject(GITHUB) private readonly github: GitHubApi | null,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly issues: IssuesService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async handle(event: string, payload: PullRequestPayload): Promise<ReviewOutcome> {
    const runId = AGENT_BRANCH.exec(payload.pull_request.head.ref)?.[1];
    if (runId === undefined) return { kind: 'ignored', why: 'not an agent branch' };

    if (event === 'pull_request' && payload.action === 'closed') {
      return payload.pull_request.merged
        ? this.merged(runId, payload)
        : this.rejected(runId, payload, 'closed', null);
    }
    if (
      event === 'pull_request_review' &&
      payload.action === 'submitted' &&
      payload.review?.state === 'changes_requested'
    ) {
      return this.rejected(runId, payload, 'changes_requested', payload.review);
    }
    return { kind: 'ignored', why: `${event} ${payload.action} decides nothing` };
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
    if (how === 'changes_requested' && this.github) {
      const next = (issue.current_tier ?? 0) + 1;
      await this.github
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
    if (review?.body?.trim()) parts.push(`Review:\n${review.body.trim()}`);
    if (this.github) {
      try {
        if (review) {
          const inline = await this.github.reviewComments(pr, review.id);
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
        const conversation = (await this.github.issueComments(pr)).filter((c) => c.body.trim());
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
