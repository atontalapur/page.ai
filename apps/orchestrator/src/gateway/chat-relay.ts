import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { RunChat } from '@page/contracts';
import { ChatsService } from '../chats/chats.service.ts';
import { UiGateway } from './ui.gateway.ts';

/**
 * Sends each message change to every tab: a stored message as `run.chat.asked`, and its
 * answer, or why it has none, as `run.chat.reply`. So every open tab shows the conversation
 * as it happens, the asker's included.
 */
@Injectable()
export class ChatRelay implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly chats: ChatsService,
    private readonly ui: UiGateway,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.chats.subscribe((chat) => this.relay(chat));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private relay(chat: RunChat): void {
    if (chat.status === 'pending') this.ui.send('run.chat.asked', { v: 1, chat });
    else this.ui.send('run.chat.reply', { v: 1, chat });
  }
}
