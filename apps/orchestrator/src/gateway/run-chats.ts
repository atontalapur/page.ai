import { Inject, Injectable } from '@nestjs/common';
import type { ChatRefusal } from '@page/contracts';
import { ChatsService } from '../chats/chats.service.ts';
import type { Logger } from '../logger.ts';
import { RunsService } from '../runs/runs.service.ts';
import { LOGGER } from '../tokens.ts';
import { Nodes } from './nodes.ts';

/**
 * The most messages one run takes, from every tab together. Each one stays in the agent's
 * context for the rest of the run, so this bounds what people can add to its cost.
 */
export const MAX_CHATS_PER_RUN = 10;

/** Who sent a message, as the server took it from their socket. */
export interface Asker {
  /** What the record says: `ui:<name>`. */
  askedBy: string;
  /** What the agent is shown. */
  from: string;
}

/**
 * Sends a person's message to the daemon holding a run in progress. The run must be its
 * issue's run in progress, a connected daemon must hold it, and it must have had fewer than
 * MAX_CHATS_PER_RUN messages; otherwise nothing is stored and the caller gets the reason.
 * A message is stored before it is sent, so its answer has a row to land in. A daemon that
 * left between the check and the send leaves the message closed as `no_daemon`.
 */
@Injectable()
export class RunChats {
  constructor(
    private readonly chats: ChatsService,
    private readonly runs: RunsService,
    private readonly nodes: Nodes,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async ask(runId: string, message: string, asker: Asker): Promise<ChatRefusal | undefined> {
    const owner = await this.runs.owner(runId);
    if (!owner?.current) return 'not_in_progress';
    if (this.nodes.holder(runId) === undefined) return 'no_daemon';
    if ((await this.chats.count(runId)) >= MAX_CHATS_PER_RUN) return 'too_many';

    const chat = await this.chats.ask({
      runId,
      issueId: owner.issueId,
      askedBy: asker.askedBy,
      message,
    });
    const sent = this.nodes.send(runId, 'run.chat', {
      v: 1,
      chatId: chat.id,
      runId,
      from: asker.from,
      message,
    });
    if (!sent) {
      this.logger.warn({ chatId: chat.id, runId }, 'the daemon left before the message went out');
      await this.chats.close({ id: chat.id }, 'no_daemon');
    }
    return undefined;
  }
}
