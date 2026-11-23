import { Module } from '@nestjs/common';
import { ChatsService } from './chats.service.ts';

// GatewayModule imports it: tabs' messages and daemons' answers come over the sockets, and
// ChatRelay sends each change back out. GET /issues/:id/runs reads the rows itself.
@Module({
  providers: [ChatsService],
  exports: [ChatsService],
})
export class ChatsModule {}
