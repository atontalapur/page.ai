import { Module } from '@nestjs/common';
import { NotifyController } from './notify.controller.ts';
import { NotifyService } from './notify.service.ts';

@Module({
  controllers: [NotifyController],
  providers: [NotifyService],
})
export class NotifyModule {}
