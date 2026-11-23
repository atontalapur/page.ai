import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.ts';
import { NodeGateway } from './node.gateway.ts';
import { Nodes } from './nodes.ts';
import { RunKills } from './run-kills.ts';
import { UiGateway } from './ui.gateway.ts';

// The UI's namespace (`/ui`, ORCHESTRATOR_API_TOKEN) and the node daemons' (`/node`,
// NODE_SHARED_SECRET), on the HTTP port. Nodes knows which daemon holds each run, and
// RunKills sends a cancelled run's daemon `run.kill`.
@Module({
  imports: [RunsModule],
  providers: [UiGateway, NodeGateway, Nodes, RunKills],
  exports: [UiGateway, Nodes, RunKills],
})
export class GatewayModule {}
