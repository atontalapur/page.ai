import { Module } from '@nestjs/common';
import { DebugController } from './debug.controller.ts';
import { DebugService } from './debug.service.ts';

@Module({
  controllers: [DebugController],
  providers: [DebugService],
})
export class DebugModule {}
