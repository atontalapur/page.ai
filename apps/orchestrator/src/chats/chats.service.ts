import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type {
  ChatCloseReason,
  ClosedChat,
  NodeToServerEvents,
  PendingChat,
  RunChat,
} from '@page/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/database.ts';
import { IssueUpdates } from '../issues/issue-updates.ts';
import type { Logger } from '../logger.ts';
import { DB, LOGGER } from '../tokens.ts';
import { toChat } from './chat-row.ts';

export type ChatReply = Parameters<NodeToServerEvents['node.chat.reply']>[0];

/** Each message as it is stored, answered or closed. GatewayModule relays it to the tabs. */
export type ChatListener = (chat: RunChat) => void;

/** What a person asks, with the identity the server took from their socket. */
export interface NewChat {
  runId: string;
  issueId: string;
  askedBy: string;
  message: string;
}

type ChatMatch = { id: string } | { runId: string } | { issueId: string };

/**
 * Holds the messages people send runs in progress, and the agents' answers (`run_chats`).
 *
 * A message is stored pending when the gateway sends it to the daemon holding the run. It is
 * closed once: answered, or unanswered with a reason, when the daemon reports it, or by the
 * server when its run stops (`run_ended`: it finished, was killed or replaced, or the issue
 * left `fixing`). A second report for the same message changes nothing. Listeners hear each
 * message once it is stored and again once it is closed.
 */
@Injectable()
export class ChatsService implements OnModuleInit, OnModuleDestroy {
  private readonly listeners = new Set<ChatListener>();
  private unsubscribe: (() => void) | undefined;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly updates: IssueUpdates,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.updates.subscribe((issue, { cancelledRunId }) => {
      // A cancelled run is told to stop, and an issue out of `fixing` has no run in progress,
      // so no agent will read what is still waiting.
      if (cancelledRunId !== undefined) this.closeLater({ runId: cancelledRunId });
      if (issue.status !== 'fixing') this.closeLater({ issueId: issue.id });
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Adds `listener`, and returns the function that removes it. */
  subscribe(listener: ChatListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How many messages people have sent `runId`, answered or not. */
  async count(runId: string): Promise<number> {
    const row = await this.db
      .selectFrom('run_chats')
      .select((eb) => eb.fn.countAll<string | number>().as('n'))
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Stores a message pending, and tells listeners. */
  async ask(chat: NewChat): Promise<PendingChat> {
    const row = await this.db
      .insertInto('run_chats')
      .values({
        run_id: chat.runId,
        issue_id: chat.issueId,
        asked_by: chat.askedBy,
        message: chat.message,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const stored = toChat(row) as PendingChat;
    this.logger.info(
      { chatId: stored.id, runId: chat.runId, issueId: chat.issueId, askedBy: chat.askedBy },
      'message for a run stored',
    );
    this.publish(stored);
    return stored;
  }

  /**
   * Records what the daemon says of a message: the agent's answer, or why it has none.
   * Undefined when the message isn't pending for that run: closed already, or unknown.
   */
  async reply(reply: ChatReply): Promise<ClosedChat | undefined> {
    const closed =
      reply.status === 'answered'
        ? { status: 'answered' as const, answer: reply.answer }
        : { status: 'unanswered' as const, reason: reply.reason };
    const row = await this.db
      .updateTable('run_chats')
      .set({ ...closed, closed_at: sql<Date>`now()` })
      .where('id', '=', reply.chatId)
      .where('run_id', '=', reply.runId)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();
    const log = { chatId: reply.chatId, runId: reply.runId, status: reply.status };
    if (row === undefined) {
      this.logger.warn(log, 'reply for a message that is not pending on that run; dropped');
      return undefined;
    }
    const chat = toChat(row) as ClosedChat;
    this.logger.info(log, 'message for a run closed by its daemon');
    this.publish(chat);
    return chat;
  }

  /** Closes the pending messages that match as unanswered, and tells listeners. */
  async close(match: ChatMatch, reason: ChatCloseReason): Promise<ClosedChat[]> {
    let query = this.db
      .updateTable('run_chats')
      .set({ status: 'unanswered', reason, closed_at: sql<Date>`now()` })
      .where('status', '=', 'pending');
    if ('id' in match) query = query.where('id', '=', match.id);
    else if ('runId' in match) query = query.where('run_id', '=', match.runId);
    else query = query.where('issue_id', '=', match.issueId);
    const rows = await query.returningAll().execute();
    const closed = rows.map((row) => toChat(row) as ClosedChat);
    for (const chat of closed) {
      this.logger.info(
        { chatId: chat.id, runId: chat.runId, issueId: chat.issueId, reason },
        'message for a run closed by the server',
      );
      this.publish(chat);
    }
    return closed;
  }

  /** Closes a finished run's pending messages as `run_ended`. */
  closeRun(runId: string): Promise<ClosedChat[]> {
    return this.close({ runId }, 'run_ended');
  }

  /** close() from a listener that can't wait on it. A failure is logged. */
  private closeLater(match: { runId: string } | { issueId: string }): void {
    this.close(match, 'run_ended').catch((err: unknown) => {
      this.logger.error({ err, ...match }, 'could not close the messages of a run that ended');
    });
  }

  private publish(chat: RunChat): void {
    for (const listener of this.listeners) {
      try {
        listener(chat);
      } catch (err) {
        this.logger.error({ err, chatId: chat.id }, 'chat listener failed');
      }
    }
  }
}
