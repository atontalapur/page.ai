import { Inject, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import {
  approverNameSchema,
  deciderFor,
  serverToUiEvents,
  UI_NAMESPACE,
  uiToServerEvents,
  type ChatRefusal,
  type ServerToUiEvents,
  type UiToServerEvents,
} from '@page/contracts';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { ApprovalsService } from '../approvals/approvals.service.ts';
import { ApiTokens, type Caller } from '../auth/api-tokens.ts';
import { actorOf } from '../auth/caller.ts';
import { IssueUpdates } from '../issues/issue-updates.ts';
import type { Logger } from '../logger.ts';
import { RateLimiter } from '../rate-limit.ts';
import { LOGGER } from '../tokens.ts';
import { RunChats } from './run-chats.ts';
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
  /** Who the handshake's token names. Set before the socket joins. */
  caller: Caller;
  /** What the tab's Tier 3 decisions are recorded as, or undefined when it can't decide. */
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
// A message to a run is cheap to send and dear to answer: it rides along in every model call
// the run makes after it. A person reading the run and typing sends one every few steps at
// most, and a step takes a model call and a command, so 5 a minute is plenty. Past it the
// message is refused with `rate_limited` and the socket stays open.
export const CHATS_PER_MINUTE = 5;

/** The person's name in a decider, `ui:<name>` (deciderFor), to show the agent. */
const nameIn = (decider: string) => decider.replace(/^ui:/, '');

/**
 * The Socket.IO namespace for the UI. A handshake needs a token the HTTP API takes (ApiTokens)
 * as `auth.token`: ORCHESTRATOR_API_TOKEN or a person's dashboard token. Without one it is
 * refused with `unauthorized`, and an address past its wrong tokens with `rate_limited`.
 * Every issue change IssuesService commits goes to every connected tab as `issue.updated`,
 * and NodeGateway sends each run's events through `send`. What a tab sends is checked against
 * `uiToServerEvents`, and one that fails is logged and dropped.
 *
 * Who decides a Tier 3 request comes from the handshake, never from what the tab sends:
 *
 * - A personal token decides as the person it names, `ui:<name>`. Any `auth.name` is ignored.
 * - The shared token, once any personal token is configured, can't decide.
 * - The shared token, with none configured, decides under the name the tab sends as
 *   `auth.name` (approverNameSchema), as `ui:<name>`. That name is what someone typed, not a
 *   login: anyone with the token can connect under any name. Boot warns while this holds.
 *
 * A message a tab sends a run (`run.chat`) is recorded the same way, under the tab's
 * decider, and a tab that can't decide can't send one.
 */
@WebSocketGateway({ namespace: UI_NAMESPACE, serveClient: false })
export class UiGateway implements OnGatewayInit<UiNamespace>, OnGatewayConnection, OnModuleDestroy {
  private readonly guard: SocketGuard;
  private readonly chatLimit = new RateLimiter(CHATS_PER_MINUTE, 60_000);
  private namespace: UiNamespace | undefined;
  private unsubscribe: (() => void) | undefined;

  /**
   * What each event a tab sends does once it passes its contract. An event with no handler
   * is logged and dropped, so a new one goes here.
   */
  private readonly handlers: { [E in TabEvent]?: Handler<E> } = {
    // Recorded under the tab's decider when it has one, so a name label counts here too.
    'run.kill': (socket, { runId }) =>
      this.kills.kill(runId, socket.data.decider ?? actorOf(socket.data.caller)),
    'run.chat': (socket, { runId, message }) => this.chat(socket, runId, message),
    'approval.decide': (socket, { approvalId, decision }) =>
      this.decide(socket, approvalId, decision),
  };

  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly tokens: ApiTokens,
    private readonly updates: IssueUpdates,
    private readonly kills: RunKills,
    private readonly approvals: ApprovalsService,
    private readonly chats: RunChats,
  ) {
    this.guard = {
      name: 'ui',
      admit: (token, socket: UiSocket) => {
        const check = this.tokens.check(token, socketAddress(socket));
        if (!check.ok) return check.refusal;
        socket.data.caller = check.caller;
        return undefined;
      },
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
    const decider = this.deciderOf(socket);
    if (decider !== undefined) socket.data.decider = decider;
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
   * What a tab's decisions are recorded as (the class comment says when), or undefined when
   * it can't decide.
   */
  private deciderOf(socket: UiSocket): string | undefined {
    const { caller } = socket.data;
    if (caller.kind === 'person') return deciderFor(caller.name);
    if (this.tokens.personal) return undefined;
    const { name } = socket.handshake.auth as { name?: unknown };
    const parsed = approverNameSchema.safeParse(name);
    if (parsed.success) return deciderFor(parsed.data);
    if (name !== undefined) {
      this.logger.warn({ address: socketAddress(socket) }, 'ui socket gave a name it may not use');
    }
    return undefined;
  }

  /**
   * A person's decision on a Tier 3 request, recorded as the tab's decider. A tab without one
   * can't decide. A second decision is refused, and the tab that sent it gets the one that
   * stands, so it stops showing the request.
   */
  private async decide(
    socket: UiSocket,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    const { decider, caller } = socket.data;
    if (decider === undefined) {
      const why =
        caller.kind === 'shared' && this.tokens.personal
          ? 'the shared token, which may not decide once personal tokens are configured'
          : 'a tab that gave no name';
      this.logger.warn({ approvalId }, `approval.decide from ${why}; dropped`);
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
   * A person's message to a run in progress, recorded as the tab's decider: a personal
   * token's person, or the tab's name label only while no personal token is configured. On
   * top of the socket's message limit, each tab may send CHATS_PER_MINUTE. A message that
   * isn't sent on (no identity, over the limit, or RunChats turned it away) is stored
   * nowhere, and only this tab hears why, as `run.chat.refused`.
   */
  private async chat(socket: UiSocket, runId: string, message: string): Promise<void> {
    const { decider } = socket.data;
    let refusal: ChatRefusal | undefined;
    if (decider === undefined) refusal = 'no_name';
    else if (!this.chatLimit.hit(socket.id).allowed) refusal = 'rate_limited';
    else
      refusal = await this.chats.ask(runId, message, { askedBy: decider, from: nameIn(decider) });
    if (refusal === undefined) return;
    this.logger.warn({ runId, reason: refusal, decider }, 'run.chat refused');
    this.emit(socket, 'run.chat.refused', { v: 1, runId, reason: refusal });
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
