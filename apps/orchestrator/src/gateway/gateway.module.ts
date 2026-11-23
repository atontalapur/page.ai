import { Module } from '@nestjs/common';
import { UiGateway } from './ui.gateway.ts';

// The node daemons' namespace (`/node`, NODE_SHARED_SECRET) joins this module with the run
// events it carries.
@Module({
  providers: [UiGateway],
})
export class GatewayModule {}
