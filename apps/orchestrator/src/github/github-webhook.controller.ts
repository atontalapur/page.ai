import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SkipApiToken } from '../auth/api-token.guard.ts';
import type { Config } from '../config.ts';
import { CONFIG } from '../tokens.ts';
import { GitHubReviewService, type PullRequestPayload } from './github-review.service.ts';

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
 * The demo repo's webhook. It checks GitHub's signature over the raw body with
 * GITHUB_WEBHOOK_SECRET, not the API token, and answers 404 while GitHub isn't set up.
 */
@Controller('ingest')
@SkipApiToken()
export class GitHubWebhookController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly reviews: GitHubReviewService,
  ) {}

  @Post('github')
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    const github = this.config.github;
    if (!github) throw new NotFoundException('GitHub is not set up on this orchestrator');
    if (!request.rawBody || !signedByGitHub(request.rawBody, signature, github.webhookSecret)) {
      throw new UnauthorizedException();
    }
    if (event === 'ping') return { kind: 'ignored', why: 'ping' };
    const payload = request.body as Partial<PullRequestPayload> | undefined;
    if (!event || !payload?.pull_request?.head?.ref) {
      return { kind: 'ignored', why: 'not a pull request event' };
    }
    return this.reviews.handle(event, payload as PullRequestPayload);
  }
}
