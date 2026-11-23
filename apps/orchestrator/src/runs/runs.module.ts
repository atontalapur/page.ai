import { Module } from '@nestjs/common';
import { RunsController } from './runs.controller.ts';
import { RunsService } from './runs.service.ts';

@Module({
  controllers: [RunsController],
  providers: [RunsService],
  // IssuesController serves GET /issues/:id/runs from it.
  exports: [RunsService],
})
export class RunsModule {}
