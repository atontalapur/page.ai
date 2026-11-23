import { Module } from '@nestjs/common';
import { NodeRuns } from './node-runs.ts';
import { RunsController } from './runs.controller.ts';
import { StatsController } from './stats.controller.ts';
import { RunsService } from './runs.service.ts';

@Module({
  controllers: [RunsController, StatsController],
  providers: [RunsService, NodeRuns],
  // IssuesController serves GET /issues/:id/runs from RunsService, and the gateway records
  // and lists each daemon's runs with NodeRuns.
  exports: [RunsService, NodeRuns],
})
export class RunsModule {}
