import { Module } from '@nestjs/common';
import { RunsController } from './runs.controller.ts';
import { RunsService } from './runs.service.ts';

@Module({
  controllers: [RunsController],
  providers: [RunsService],
})
export class RunsModule {}
