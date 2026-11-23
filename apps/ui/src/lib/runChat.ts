import type { ChatCloseReason, NodeSummary, RunChat, Step } from '@page/contracts';

import type { AskFailure } from '../live/source';

/** Where a message stands, in a line under it. Null for an answered one: its answer shows. */
export function chatStatus(chat: RunChat): string | null {
  if (chat.status === 'answered') return null;
  if (chat.status === 'pending') return "Waiting for the agent's next step.";
  return CLOSE_TEXT[chat.reason];
}

const CLOSE_TEXT: Record<ChatCloseReason, string> = {
  queue_full: 'Not read: too many messages were already waiting for the agent.',
  submitted: 'Not read: the agent had already submitted its fix.',
  run_ended: 'Not answered: the run ended first.',
  no_answer: 'The agent read this and did not answer.',
  no_daemon: 'Not delivered: no agent daemon held the run.',
};

/** Why a message didn't go out, under the box it was typed in. */
export const ASK_FAILURE_TEXT: Record<AskFailure, string> = {
  no_name: 'Give your name first, so the message is recorded under it.',
  rate_limited: 'Too many messages from this tab in the last minute. Wait a moment and send again.',
  not_in_progress: 'This run is no longer in progress, so the agent will not read it.',
  no_daemon: 'No agent daemon holds this run right now, so nothing would read it.',
  too_many: 'This run has had as many messages as one run takes.',
  offline: 'Not connected to the orchestrator, so the message was not sent.',
  timeout:
    'The orchestrator did not confirm the message. It may still reach the agent, so watch the run before you send it again.',
};

/**
 * Each message under the step it follows: the last step that started before it was asked,
 * or -1 when it came before the first. Messages keep the order they were asked in.
 */
export function chatsAfterSteps(
  steps: readonly Step[],
  chats: readonly RunChat[],
): Map<number, RunChat[]> {
  const after = new Map<number, RunChat[]>();
  for (const chat of chats) {
    const asked = Date.parse(chat.askedAt);
    let seq = -1;
    for (const step of steps) {
      if (Date.parse(step.createdAt) <= asked) seq = step.seq;
    }
    after.set(seq, [...(after.get(seq) ?? []), chat]);
  }
  return after;
}

/** Whether a connected daemon holds `runId` now, as the agents page shows it. */
export function heldByDaemon(nodes: readonly NodeSummary[], runId: string): boolean {
  return nodes.some((node) => node.connected && node.current.some((run) => run.id === runId));
}
