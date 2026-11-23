import type { Inbox, OnCallMessage } from '@page/agent';
import { clip, MAX_CHAT_ANSWER_CHARS, type ChatCloseReason } from '@page/contracts';
import type { Logger } from 'pino';
import type { NodePayload, OrchestratorLink, ServerPayload } from '../link/link.ts';

/**
 * The most messages that wait for the agent's next step boundary. The agent reads all of them
 * at once and answers them in one reply, so more would pile questions on one answer. Past it a
 * message is closed as `queue_full` at once.
 */
export const MAX_WAITING_CHATS = 3;

/** How the agent's part of a run ended, for the messages it will never read. */
export type InboxEnd = Extract<ChatCloseReason, 'submitted' | 'run_ended'>;

export type RunChat = ServerPayload<'run.chat'>;

/**
 * Tells the orchestrator a message got no answer. A reply that can't be sent is logged: the
 * orchestrator closes the message itself when the run finishes.
 */
export function closeChat(
  link: OrchestratorLink,
  { chatId, runId }: Pick<RunChat, 'chatId' | 'runId'>,
  reason: ChatCloseReason,
  logger: Logger,
): void {
  send(link, { v: 1, chatId, runId, status: 'unanswered', reason }, logger);
}

function send(link: OrchestratorLink, reply: NodePayload<'node.chat.reply'>, logger: Logger): void {
  try {
    link.send('node.chat.reply', reply);
  } catch (error) {
    logger.error({ err: error, chatId: reply.chatId }, 'could not send the reply to a message');
  }
}

/**
 * One run's messages from the people watching it, between the orchestrator's `run.chat` and
 * the agent loop. A message waits here until the loop reads it at its next step boundary,
 * and the answer in the reply that follows goes back as `node.chat.reply`. Every message gets
 * exactly one reply: its answer, or why it has none.
 *
 * Once the agent takes no more steps (`end`), a message that arrives gets no answer:
 * `submitted` when the agent submitted its fix, `run_ended` for any other end.
 */
export class RunInbox implements Inbox {
  private readonly runId: string;
  private readonly link: OrchestratorLink;
  private readonly logger: Logger;
  private waiting: OnCallMessage[] = [];
  // Read by the agent, and waiting on the reply to that model call.
  private readonly shown = new Map<string, OnCallMessage>();
  private ended: InboxEnd | undefined;

  constructor({ runId, link, logger }: { runId: string; link: OrchestratorLink; logger: Logger }) {
    this.runId = runId;
    this.link = link;
    this.logger = logger;
  }

  /** A message from the orchestrator for this run. */
  deliver({ chatId, from, message }: RunChat): void {
    const log = { chatId, from };
    if (this.ended !== undefined) {
      this.logger.info({ ...log, reason: this.ended }, 'message after the agent stopped; closed');
      this.close(chatId, this.ended);
      return;
    }
    if (this.waiting.length >= MAX_WAITING_CHATS) {
      this.logger.warn(log, 'too many messages waiting for the agent; closed');
      this.close(chatId, 'queue_full');
      return;
    }
    this.logger.info(log, 'message for the agent; it reads it at its next step');
    this.waiting.push({ id: chatId, from, text: message });
  }

  take(): OnCallMessage[] {
    const taken = this.waiting;
    this.waiting = [];
    for (const message of taken) this.shown.set(message.id, message);
    return taken;
  }

  answer(messages: readonly OnCallMessage[], reply: string | null): void {
    for (const { id } of messages) {
      if (!this.shown.delete(id)) continue;
      if (reply === null) {
        this.logger.info({ chatId: id }, 'the agent read a message and did not answer it');
        this.close(id, 'no_answer');
        continue;
      }
      send(
        this.link,
        {
          v: 1,
          chatId: id,
          runId: this.runId,
          status: 'answered',
          answer: clip(reply, MAX_CHAT_ANSWER_CHARS),
        },
        this.logger,
      );
    }
  }

  /**
   * The agent takes no more steps. Messages still waiting are closed as `reason`, ones it read
   * and never answered (the model call failed, the run was killed) as `run_ended`, and any
   * that arrive later as `reason`. Only the first call counts.
   */
  end(reason: InboxEnd): void {
    if (this.ended !== undefined) return;
    this.ended = reason;
    for (const { id } of this.waiting) this.close(id, reason);
    for (const id of this.shown.keys()) this.close(id, 'run_ended');
    this.waiting = [];
    this.shown.clear();
  }

  private close(chatId: string, reason: ChatCloseReason): void {
    closeChat(this.link, { chatId, runId: this.runId }, reason, this.logger);
  }
}
