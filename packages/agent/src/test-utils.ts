import type {
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  ModelClient,
  ModelError,
} from '@page/model-client';
import { err, ok, type ExecErr, type ExecOk, type Result, type ToolCall } from '@page/toolkit';
import type { ExecuteFn, ExecuteOptions } from './agent.ts';

export type ScriptedReply = string | { content: string; costUsd?: number; finishReason?: string };

/** A ModelClient that answers with `replies` in order and records what it was sent. */
export class ScriptedModel implements ModelClient {
  readonly calls: ChatMessage[][] = [];
  readonly options: (CompleteOptions | undefined)[] = [];
  /** Runs before each reply, e.g. to move a fake clock. */
  onCall: () => void = () => {};
  private next = 0;
  private readonly replies: readonly (ScriptedReply | ModelError)[];
  private readonly defaultCostUsd: number;

  constructor(replies: readonly (ScriptedReply | ModelError)[], defaultCostUsd = 0) {
    this.replies = replies;
    this.defaultCostUsd = defaultCostUsd;
  }

  complete(messages: readonly ChatMessage[], options?: CompleteOptions): Promise<CompletionResult> {
    this.calls.push(structuredClone([...messages]));
    this.options.push(options);
    this.onCall();
    const reply = this.replies[this.next++];
    if (reply === undefined) throw new Error(`ScriptedModel ran out of replies at ${this.next}`);
    if (typeof reply === 'object' && 'kind' in reply) {
      return Promise.resolve({ ok: false, error: reply });
    }
    const r = typeof reply === 'string' ? { content: reply } : reply;
    return Promise.resolve({
      ok: true,
      completion: {
        content: r.content,
        finishReason: r.finishReason ?? 'stop',
        model: 'scripted',
        costUsd: r.costUsd ?? this.defaultCostUsd,
      },
    });
  }
}

type Responder = (call: ToolCall) => Result<ExecOk, ExecErr>;

/** An `execute()` stand-in that records each call; by default every call exits 0 silently. */
export function fakeExecute(respond: Responder = (call) => okResult(call)) {
  const calls: ToolCall[] = [];
  const options: ExecuteOptions[] = [];
  const execute: ExecuteFn = (call, opts) => {
    calls.push(call);
    options.push(opts);
    return Promise.resolve(respond(call));
  };
  return { execute, calls, options };
}

function inputOf(call: ToolCall): string {
  if (call.kind === 'exec') return call.command;
  if (call.kind === 'edit') {
    return JSON.stringify({ path: call.path, oldText: call.oldText, newText: call.newText });
  }
  return JSON.stringify(
    call.tool === 'git.pushBranch'
      ? { tool: call.tool, message: call.message }
      : { tool: call.tool, title: call.title, body: call.body },
  );
}

export const okResult = (call: ToolCall, output = '') =>
  ok<ExecOk>({ kind: call.kind, input: inputOf(call), exitCode: 0, output });

export const failedResult = (call: ToolCall, exitCode: number, output: string) =>
  err<ExecErr>({ kind: call.kind, input: inputOf(call), type: 'failed', exitCode, output });

export const bash = (command: string, thought = 'THOUGHT: next step.') =>
  `${thought}\n\n\`\`\`page_bash\n${command}\n\`\`\``;

export const submit = (thought = 'THOUGHT: the fix is in and the tests pass.') =>
  `${thought}\n\n\`\`\`page_submit\n\`\`\``;
