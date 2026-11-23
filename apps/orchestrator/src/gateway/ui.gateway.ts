import { Inject, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import {
  serverToUiEvents,
  UI_NAMESPACE,
  type Issue,
  type ServerToUiEvents,
  type UiToServerEvents,
} from '@page/contracts';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { IssueUpdates } from '../issues/issue-updates.ts';
import type { Logger } from '../logger.ts';
import { RateLimiter } from '../rate-limit.ts';
import { CONFIG, LOGGER } from '../tokens.ts';
import { guardHandshakes, limitMessages, type SocketGuard } from './socket-guard.ts';

type UiNamespace = Namespace<UiToServerEvents, ServerToUiEvents>;
type UiSocket = Socket<UiToServerEvents, ServerToUiEvents>;

// A tab connects once, and socket.io-client retries a dropped connection at most every 5s,
// so one tab stays under 12 handshakes a minute even while the server is down. 30 leaves
// room for a few tabs behind one address, and holds a token guesser to 30 tries a minute.
export const HANDSHAKES_PER_MINUTE = 30;
// The UI sends nothing yet. Kill, chat and approval decisions (#9) are clicks, so 20 in 10s
// is far above what a person sends, and a socket past it is closed.
export const MESSAGES_PER_10_SECONDS = 20;

/**
 * The Socket.IO namespace for the UI. A handshake needs ORCHESTRATOR_API_TOKEN as
 * `auth.token`, the same token as the HTTP API, and is refused with `unauthorized` without
 * it. Every issue change IssuesService commits goes to every connected tab as `issue.updated`.
 */
@WebSocketGateway({ namespace: UI_NAMESPACE, serveClient: false })
export class UiGateway implements OnGatewayInit<UiNamespace>, OnGatewayConnection, OnModuleDestroy {
  private readonly guard: SocketGuard;
  private unsubscribe: (() => void) | undefined;

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly updates: IssueUpdates,
  ) {
    this.guard = {
      name: 'ui',
      secret: config.apiToken,
      handshakes: new RateLimiter(HANDSHAKES_PER_MINUTE, 60_000),
      messages: new RateLimiter(MESSAGES_PER_10_SECONDS, 10_000),
      logger,
    };
  }

  afterInit(namespace: UiNamespace): void {
    guardHandshakes(namespace, this.guard);
    this.unsubscribe = this.updates.subscribe((issue) => this.sendIssue(namespace, issue));
  }

  handleConnection(socket: UiSocket): void {
    limitMessages(socket, this.guard);
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Checks the payload against its contract, so a tab never gets one it would reject. */
  private sendIssue(namespace: UiNamespace, issue: Issue): void {
    const payload = serverToUiEvents['issue.updated'].safeParse({ v: 1, issue });
    if (!payload.success) {
      this.logger.error(
        { issueId: issue.id, problems: z.prettifyError(payload.error) },
        'issue.updated failed its contract; not sent',
      );
      return;
    }
    namespace.emit('issue.updated', payload.data);
  }
}
