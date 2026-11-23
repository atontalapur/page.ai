import { Module } from '@nestjs/common';
import { NodeGateway } from './node.gateway.ts';
import { UiGateway } from './ui.gateway.ts';

// The UI's namespace (`/ui`, ORCHESTRATOR_API_TOKEN) and the node daemons' (`/node`,
// NODE_SHARED_SECRET), on the HTTP port.
@Module({
  providers: [UiGateway, NodeGateway],
})
export class GatewayModule {}
