import { ACTION_TAGS } from '@page/agent';
import type { ChatMessage, CompletionResult, ModelClient } from '@page/model-client';

const FENCE = '```';

/** A reply that runs one shell command. */
export const bashReply = (command: string, thought = 'THOUGHT: look around first.') =>
  `${thought}\n\n${FENCE}${ACTION_TAGS.exec}\n${command}\n${FENCE}`;

/** A reply that submits the run. */
export const submitReply = (thought = 'THOUGHT: done.') =>
  `${thought}\n\n${FENCE}${ACTION_TAGS.submit}\n${FENCE}`;

/**
 * What the fake model does under USE_FAKE_ADAPTERS: run the tests, then submit. In the fake
 * workspace (fakeWorkspace) the tests pass, so the run scores above the threshold.
 */
export const FAKE_REPLIES = [
  bashReply('pnpm --filter @page/demo-app test', 'THOUGHT: check the tests pass.'),
  submitReply(),
];

/**
 * A ModelClient that answers with `replies` in order, at no cost. Each run starts from the
 * first reply: the next one is picked by how many replies the run's messages already hold,
 * so the one model a daemon builds under the fakes serves all its runs. Once they run out
 * it keeps submitting, so a run under the fake always ends. Counts the calls it gets.
 */
export class ScriptedModel implements ModelClient {
  calls = 0;
  private readonly replies: readonly string[];

  constructor(replies: readonly string[] = FAKE_REPLIES) {
    this.replies = replies;
  }

  complete(messages: readonly ChatMessage[]): Promise<CompletionResult> {
    const step = messages.filter((message) => message.role === 'assistant').length;
    const content = this.replies[step] ?? submitReply();
    this.calls += 1;
    return Promise.resolve({
      ok: true,
      completion: { content, finishReason: 'stop', model: 'scripted', costUsd: 0 },
    });
  }
}
