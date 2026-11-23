import { Inject, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import {
  approverNameSchema,
  deciderFor,
  serverToUiEvents,
  UI_NAMESPACE,
  uiToServerEvents,
  type ServerToUiEvents,
  type UiToServerEvents,
} from '@page/contracts';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service.ts';
import type { Config } from '../config.ts';
import { IssueUpdates } from '../issues/issue-updates.ts';
import type { Logger } from '../logger.ts';
import { RateLimiter } from '../rate-limit.ts';
import { CONFIG, LOGGER } from '../tokens.ts';
import { RunKills } from './run-kills.ts';
import {
  guardHandshakes,
  limitMessages,
  listen,
  socketAddress,
  type SocketGuard,
} from './socket-guard.ts';

/** What the server keeps on a tab's socket. */
interface TabData {
  /** `ui:<name>` from the handshake's `auth.name`, or undefined when it gave none. */
  decider?: string;
}

type UiNamespace = Namespace<UiToServerEvents, ServerToUiEvents, Record<string, never>, TabData>;
type UiSocket = Socket<UiToServerEvents, ServerToUiEvents, Record<string, never>, TabData>;

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
 *
 * Every tab shares the one token, so the token says nothing about who is there. A tab that
 * approves or rejects Tier 3 requests also sends the person's name as `auth.name`
 * (approverNameSchema), and each decision it sends is recorded as `ui:<name>`. The name is
 * what they typed, not a login: it tells honest teammates apart and can't be set per
 * decision, but anyone with the token can connect under any name.
 */
@WebSocketGateway({ namespace: UI_NAMESPACE, serveClient: false })
export class UiGateway implements OnGatewayInit<UiNamespace>, OnGatewayConnection, OnModuleDestroy {
  private readonly guard: SocketGuard;
  private namespace: UiNamespace | undefined;
  private unsubscribe: (() => void) | undefined;

  /**
   * What each event a tab sends does once it passes its contract. An event with no handler
   * is logged and dropped, so a new one goes here: `run.chat` once the daemon handles it.
   */
  private readonly handlers: { [E in TabEvent]?: Handler<E> } = {
    'run.kill': (_socket, { runId }) => this.kills.kill(runId),
    'approval.decide': (socket, { approvalId, decision }) =>
      this.decide(socket, approvalId, decision),
  };

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly updates: IssueUpdates,
    private readonly kills: RunKills,
    private readonly approvals: ApprovalsService,
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
    const decider = deciderOf(socket);
    if (decider !== undefined) socket.data.decider = decider;
    else if (socket.handshake.auth.name !== undefined) {
      this.logger.warn({ address: socketAddress(socket) }, 'ui socket gave a name it may not use');
    }
    listen(socket, uiToServerEvents, this.guard, (event, payload) => {
      const handler: Handler<TabEvent> | undefined = this.handlers[event];
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
   * A person's decision on a Tier 3 request, recorded under the name their tab connected
   * with. A tab with no name can't decide. A second decision is refused, and the tab that
   * sent it gets the one that stands, so it stops showing the request.
   */
  private async decide(
    socket: UiSocket,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    const { decider } = socket.data;
    if (decider === undefined) {
      this.logger.warn({ approvalId }, 'approval.decide from a tab that gave no name; dropped');
      return;
    }
    const outcome = await this.approvals.decide(approvalId, decision, decider);
    if (outcome.kind === 'not_found') {
      this.logger.warn({ approvalId }, 'approval.decide for an approval that does not exist');
    } else if (outcome.kind === 'already_decided') {
      this.emit(socket, 'approval.updated', { v: 1, approval: outcome.approval });
    }
  }

  /**
   * Sends `event` to every connected tab. Checks the payload against its contract first, so
   * a tab never gets one it would reject.
   */
  send<E extends UiEvent>(event: E, payload: UiPayload<E>): void {
    if (this.namespace) this.emit(this.namespace, event, payload);
  }

  /** Sends `event` to `to`, a tab or the namespace, if the payload passes its contract. */
  private emit<E extends UiEvent>(
    to: UiSocket | UiNamespace,
    event: E,
    payload: UiPayload<E>,
  ): void {
    const parsed = serverToUiEvents[event].safeParse(payload);
    if (!parsed.success) {
      this.logger.error(
        { event, problems: z.prettifyError(parsed.error) },
        `${event} failed its contract; not sent`,
      );
      return;
    }
    // The typed emit wants the event as a literal; the payload is already checked.
    const emit = to.emit.bind(to) as (e: string, p: unknown) => boolean;
    emit(event, parsed.data);
  }
}

/** `ui:<name>` for the name a tab's handshake gave, or undefined for none or a bad one. */
function deciderOf(socket: UiSocket): string | undefined {
  const { name } = socket.handshake.auth as { name?: unknown };
  const parsed = approverNameSchema.safeParse(name);
  return parsed.success ? deciderFor(parsed.data) : undefined;
}
