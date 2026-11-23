import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.ts';
import { ApprovalsController } from './approvals.controller.ts';
import { ApprovalsService } from './approvals.service.ts';

// GatewayModule imports it: daemons' requests and tabs' decisions come over the sockets, and
// ApprovalRelay sends each change back out.
@Module({
  imports: [RunsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
