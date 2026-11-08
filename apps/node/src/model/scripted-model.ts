import { ACTION_TAGS } from '@page/agent';
import type { CompletionResult, ModelClient } from '@page/model-client';

const FENCE = '```';

/** A reply that runs one shell command. */
export const bashReply = (command: string, thought = 'THOUGHT: look around first.') =>
  `${thought}\n\n${FENCE}${ACTION_TAGS.exec}\n${command}\n${FENCE}`;

/** A reply that submits the run. */
export const submitReply = (thought = 'THOUGHT: done.') =>
  `${thought}\n\n${FENCE}${ACTION_TAGS.submit}\n${FENCE}`;

/** What the fake model does under USE_FAKE_ADAPTERS: one harmless command, then submit. */
export const FAKE_REPLIES = [bashReply('git status'), submitReply()];

/**
 * A ModelClient that answers with `replies` in order, at no cost. Once they run out it
 * keeps submitting, so a run under the fake always ends. Counts the calls it gets.
 */
export class ScriptedModel implements ModelClient {
  calls = 0;
  private readonly replies: readonly string[];

  constructor(replies: readonly string[] = FAKE_REPLIES) {
    this.replies = replies;
  }

  complete(): Promise<CompletionResult> {
    const content = this.replies[this.calls] ?? submitReply();
    this.calls += 1;
    return Promise.resolve({
      ok: true,
      completion: { content, finishReason: 'stop', model: 'scripted', costUsd: 0 },
    });
  }
}
