import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.ts';
import { GitHubReviewService } from './github-review.service.ts';
import { GitHubWebhookController } from './github-webhook.controller.ts';

@Module({
  imports: [KnowledgeModule],
  controllers: [GitHubWebhookController],
  providers: [GitHubReviewService],
})
export class GitHubModule {}
