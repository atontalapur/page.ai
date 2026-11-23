import { Module } from '@nestjs/common';
import {
  KnowledgeController,
  NodeSecretGuard,
  RunKnowledgeController,
} from './knowledge.controller.ts';
import { KnowledgeService } from './knowledge.service.ts';

@Module({
  controllers: [KnowledgeController, RunKnowledgeController],
  providers: [KnowledgeService, NodeSecretGuard],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
