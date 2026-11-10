import { Module } from '@nestjs/common';
import { IngestController } from './ingest.controller.ts';
import { IngestService } from './ingest.service.ts';
import { PosthogWebhookGuard } from './webhook.guard.ts';

@Module({
  controllers: [IngestController],
  providers: [IngestService, PosthogWebhookGuard],
})
export class IngestModule {}
