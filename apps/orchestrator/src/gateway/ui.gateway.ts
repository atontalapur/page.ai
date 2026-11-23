import { Inject, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import {
  serverToUiEvents,
  UI_NAMESPACE,
  uiToServerEvents,
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
import { RunKills } from './run-kills.ts';
import { guardHandshakes, limitMessages, listen, type SocketGuard } from './socket-guard.ts';

type UiNamespace = Namespace<UiToServerEvents, ServerToUiEvents>;
type UiSocket = Socket<UiToServerEvents, ServerToUiEvents>;

export type UiEvent = keyof ServerToUiEvents;
export type UiPayload<E extends UiEvent> = Parameters<ServerToUiEvents[E]>[0];

type TabEvent = keyof UiToServerEvents;
type TabPayload<E extends TabEvent> = Parameters<UiToServerEvents[E]>[0];
type Handler<E extends TabEvent> = (socket: UiSocket, payload: TabPayload<E>) => Promise<void>;

// A tab connects once, and socket.io-client retries a dropped connection at most every 5s,
// so one tab stays under 12 handshakes a minute even while the server is down. 30 leaves
// room for a few tabs behind one address, and holds a token guesser to 30 tries a minute.
export const HANDSHAKES_PER_MINUTE = 30;
// Kill, chat and approval decisions (#9) are clicks, so 20 in 10s is far above what a person
// sends, and a socket past it is closed.
export const MESSAGES_PER_10_SECONDS = 20;

/**
 * The Socket.IO namespace for the UI. A handshake needs ORCHESTRATOR_API_TOKEN as
 * `auth.token`, the same token as the HTTP API, and is refused with `unauthorized` without
 * it. Every issue change IssuesService commits goes to every connected tab as `issue.updated`,
 * and NodeGateway sends each run's events through `send`. What a tab sends is checked against
 * `uiToServerEvents`, and one that fails is logged and dropped.
 */
@WebSocketGateway({ namespace: UI_NAMESPACE, serveClient: false })
export class UiGateway implements OnGatewayInit<UiNamespace>, OnGatewayConnection, OnModuleDestroy {
  private readonly guard: SocketGuard;
  private namespace: UiNamespace | undefined;
  private unsubscribe: (() => void) | undefined;

  /**
   * What each event a tab sends does once it passes its contract. An event with no handler
   * is logged and dropped, so a new one goes here: `approval.decide` comes with Tier 3
   * approvals, and `run.chat` once the daemon handles it.
   */
  private readonly handlers: { [E in TabEvent]?: Handler<E> } = {
    'run.kill': (_socket, { runId }) => this.kills.kill(runId),
  };

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly updates: IssueUpdates,
    private readonly kills: RunKills,
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
    this.namespace = namespace;
    guardHandshakes(namespace, this.guard);
    this.unsubscribe = this.updates.subscribe((issue) =>
      this.send('issue.updated', { v: 1, issue }),
    );
  }

  handleConnection(socket: UiSocket): void {
    limitMessages(socket, this.guard);
    listen(socket, uiToServerEvents, this.guard, (event, payload) => {
      const handler = this.handlers[event] as Handler<TabEvent> | undefined;
      if (!handler) {
        this.logger.warn({ event }, 'no handler for this ui event yet; dropped');
        return;
      }
      handler(socket, payload).catch((err: unknown) => {
        this.logger.error({ err, event }, 'ui event failed');
      });
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /**
   * Sends `event` to every connected tab. Checks the payload against its contract first, so
   * a tab never gets one it would reject.
   */
  send<E extends UiEvent>(event: E, payload: UiPayload<E>): void {
    const parsed = serverToUiEvents[event].safeParse(payload);
    if (!parsed.success) {
      this.logger.error(
        { event, problems: z.prettifyError(parsed.error) },
        `${event} failed its contract; not sent`,
      );
      return;
    }
    if (!this.namespace) return;
    // The typed emit wants the event as a literal; the payload is already checked.
    const emit = this.namespace.emit.bind(this.namespace) as (e: string, p: unknown) => boolean;
    emit(event, parsed.data);
  }
}
