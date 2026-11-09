import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller.ts';
import { ApprovalsService } from './approvals.service.ts';

@Module({
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
})
export class ApprovalsModule {}
