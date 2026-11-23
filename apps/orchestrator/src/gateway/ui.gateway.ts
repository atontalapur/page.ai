import { Inject, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayInit } from '@nestjs/websockets';
import {
  serverToUiEvents,
  UI_NAMESPACE,
  type Issue,
  type ServerToUiEvents,
  type SocketRefusal,
  type UiToServerEvents,
} from '@page/contracts';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { tokenAuthorized } from '../auth/bearer.ts';
import type { Config } from '../config.ts';
import { IssueUpdates } from '../issues/issue-updates.ts';
import type { Logger } from '../logger.ts';
import { CONFIG, LOGGER } from '../tokens.ts';

type UiNamespace = Namespace<UiToServerEvents, ServerToUiEvents>;
type UiSocket = Socket<UiToServerEvents, ServerToUiEvents>;

/**
 * The Socket.IO namespace for the UI. A handshake needs ORCHESTRATOR_API_TOKEN as
 * `auth.token`, the same token as the HTTP API, and is refused with `unauthorized` without
 * it. Every issue change IssuesService commits goes to every connected tab as `issue.updated`.
 */
@WebSocketGateway({ namespace: UI_NAMESPACE, serveClient: false })
export class UiGateway implements OnGatewayInit<UiNamespace>, OnModuleDestroy {
  private unsubscribe: (() => void) | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly updates: IssueUpdates,
  ) {}

  afterInit(namespace: UiNamespace): void {
    // Middleware runs before the socket joins, so a refused one never receives an event.
    namespace.use((socket, next) => {
      const refusal = this.refusal(socket);
      if (refusal) return next(new Error(refusal satisfies SocketRefusal));
      next();
    });
    this.unsubscribe = this.updates.subscribe((issue) => this.sendIssue(namespace, issue));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private refusal(socket: UiSocket): SocketRefusal | undefined {
    const { token } = socket.handshake.auth as { token?: unknown };
    if (!tokenAuthorized(token, this.config.apiToken)) return 'unauthorized';
    return undefined;
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
