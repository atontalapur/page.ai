import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.ts';
import { RunsModule } from '../runs/runs.module.ts';
import { ApprovalRelay } from './approval-relay.ts';
import { NodeGateway } from './node.gateway.ts';
import { NodeSummaries } from './node-summaries.ts';
import { Nodes } from './nodes.ts';
import { NodesController } from './nodes.controller.ts';
import { RunKills } from './run-kills.ts';
import { UiGateway } from './ui.gateway.ts';

// The UI's namespace (`/ui`, ORCHESTRATOR_API_TOKEN) and the node daemons' (`/node`,
// NODE_SHARED_SECRET), on the HTTP port. Nodes knows which daemon holds each run, and
// RunKills sends a cancelled run's daemon `run.kill`. GET /nodes lists the daemons for the
// agents page, and `node.updated` tells the tabs when one changes. ApprovalRelay sends each
// approval change to the tabs and the daemon that asked.
@Module({
  imports: [RunsModule, ApprovalsModule],
  controllers: [NodesController],
  providers: [UiGateway, NodeGateway, Nodes, NodeSummaries, RunKills, ApprovalRelay],
  exports: [UiGateway, Nodes, RunKills],
})
export class GatewayModule {}
