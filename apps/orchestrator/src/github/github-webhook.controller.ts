import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SkipApiToken } from '../auth/api-token.guard.ts';
import { GitHubAppService } from './github-app.service.ts';
import {
  GitHubReviewService,
  type IssueCommentPayload,
  type PullRequestPayload,
} from './github-review.service.ts';

/** Whether `signature` (X-Hub-Signature-256) is GitHub's HMAC of `body` under `secret`. */
export function signedByGitHub(
  body: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The demo repo's webhook. It checks GitHub's signature over the raw body with the GitHub
 * App's webhook secret, or GITHUB_WEBHOOK_SECRET, not the API token, and answers 404 while
 * neither is set up.
 */
@Controller('ingest')
@SkipApiToken()
export class GitHubWebhookController {
  constructor(
    private readonly app: GitHubAppService,
    private readonly reviews: GitHubReviewService,
  ) {}

  @Post('github')
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    const secrets = await this.app.webhookSecrets();
    if (secrets.length === 0) {
      throw new NotFoundException('GitHub is not set up on this orchestrator');
    }
    const body = request.rawBody;
    if (!body || !secrets.some((secret) => signedByGitHub(body, signature, secret))) {
      throw new UnauthorizedException();
    }
    if (event === 'ping') return { kind: 'ignored', why: 'ping' };
    if (event === 'issue_comment') {
      return this.reviews.handleComment(request.body as IssueCommentPayload);
    }
    const payload = request.body as Partial<PullRequestPayload> | undefined;
    if (!event || !payload?.pull_request?.head?.ref) {
      return { kind: 'ignored', why: 'not a pull request event' };
    }
    return this.reviews.handle(event, payload as PullRequestPayload);
  }
}
