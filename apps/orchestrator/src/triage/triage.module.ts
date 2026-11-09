import { Module } from '@nestjs/common';
import { TriageController } from './triage.controller.ts';
import { TriageService } from './triage.service.ts';

@Module({
  controllers: [TriageController],
  providers: [TriageService],
})
export class TriageModule {}
