import { Module } from '@nestjs/common';
import { GatewayController } from './gateway.controller.ts';
import { GatewayService } from './gateway.service.ts';

@Module({
  controllers: [GatewayController],
  providers: [GatewayService],
})
export class GatewayModule {}
