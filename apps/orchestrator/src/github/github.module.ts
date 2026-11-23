import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.ts';
import {
  GitHubAppController,
  GitHubAppRedirectController,
  GitHubTokenController,
} from './github-app.controller.ts';
import { GitHubReviewService } from './github-review.service.ts';
import { PrAnswersService } from './pr-answers.service.ts';
import { GitHubWebhookController } from './github-webhook.controller.ts';

@Module({
  imports: [KnowledgeModule],
  controllers: [
    GitHubWebhookController,
    GitHubAppController,
    GitHubAppRedirectController,
    GitHubTokenController,
  ],
  providers: [GitHubReviewService, PrAnswersService],
})
export class GitHubModule {}
