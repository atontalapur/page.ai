import { Module } from '@nestjs/common';
import { TiersController } from './tiers.controller.ts';
import { TiersService } from './tiers.service.ts';

@Module({
  controllers: [TiersController],
  providers: [TiersService],
})
export class TiersModule {}
