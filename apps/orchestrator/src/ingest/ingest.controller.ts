import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { posthogWebhookSchema, type PosthogWebhook } from '@page/contracts';
import { IngestService } from './ingest.service.ts';
import { PosthogWebhookGuard } from './webhook.guard.ts';

@Controller('ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  /** PostHog `$exception` webhook. 401 without the shared secret. */
  @Post('posthog')
  @UseGuards(PosthogWebhookGuard)
  @HttpCode(200)
  receive(@Body({ schema: posthogWebhookSchema }) body: PosthogWebhook) {
    return this.ingest.receive(body);
  }
}
