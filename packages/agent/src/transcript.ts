import type { ChatMessage, CompletionResult } from '@page/model-client';
import { hostToolArgs, type ExecErr, type ExecOk, type Result, type ToolCall } from '@page/toolkit';
import type { AgentConfig, AgentDeps, ExitStatus } from './agent.ts';
import type { AgentTask } from './prompts.ts';

/** One thing the loop did with the outside world, in the order it happened. */
export type Turn =
  // `sent` holds the messages the loop added since the previous model call (the whole
  // opening for the first), so replay can check what the model was shown.
  | { type: 'model'; sent: ChatMessage[]; reply: CompletionResult }
  | { type: 'execute'; call: ToolCall; result: Result<ExecOk, ExecErr> };

export interface Recording {
  turns: Turn[];
  /** Every `now()` reading the loop took, so a run that hit the time limit replays too. */
  clock: number[];
}

export const TRANSCRIPT_VERSION = 2;

/** A recorded run against a real model and sandbox, saved for replay tests. */
export interface Transcript extends Recording {
  version: typeof TRANSCRIPT_VERSION;
  scenario: string;
  model: string;
  recordedAt: string;
  task: AgentTask;
  config: AgentConfig;
  exitStatus: ExitStatus;
  modelCalls: number;
  costUsd: number;
  /** Whether the scenario's check.sh passed after the run; null if it wasn't run. */
  checkPassed: boolean | null;
}

/** Wraps real deps so every model reply, execute call and clock reading is logged. */
export function recordingDeps(deps: AgentDeps): Recording & { deps: AgentDeps } {
  const turns: Turn[] = [];
  const clock: number[] = [];
  const now = deps.now ?? Date.now;
  let seen = 0;
  return {
    turns,
    clock,
    deps: {
      model: {
        async complete(messages, options) {
          const sent = structuredClone(messages.slice(seen));
          seen = messages.length;
          const reply = await deps.model.complete(messages, options);
          turns.push({ type: 'model', sent, reply });
          return reply;
        },
      },
      async execute(call, options) {
        const result = await deps.execute(call, options);
        turns.push({ type: 'execute', call, result });
        return result;
      },
      now() {
        const t = now();
        clock.push(t);
        return t;
      },
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
  };
}

/** The loop did something the transcript didn't: the code or prompts changed behaviour. */
export class ReplayDivergence extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayDivergence';
  }
}

function sameCall(a: ToolCall, b: ToolCall): boolean {
  if (a.kind === 'exec') return b.kind === 'exec' && a.command === b.command;
  if (a.kind === 'edit') {
    return (
      b.kind === 'edit' && a.path === b.path && a.oldText === b.oldText && a.newText === b.newText
    );
  }
  if (b.kind !== 'host_tool') return false;
  return JSON.stringify(hostToolArgs(a)) === JSON.stringify(hostToolArgs(b));
}

const describeTurn = (turn: Turn | undefined) =>
  turn === undefined ? 'has ended' : `has an ${turn.type}`;

/** Around the first character where two strings differ, so a divergence is readable. */
function around(a: string, b: string): [string, string] {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 40);
  const cut = (text: string) => JSON.stringify(text.slice(from, i + 80));
  return [cut(a), cut(b)];
}

function checkSent(at: number, got: readonly ChatMessage[], recorded: readonly ChatMessage[]) {
  if (got.length !== recorded.length) {
    throw new ReplayDivergence(
      `turn ${at}: the loop sent ${got.length} new messages, the recording has ${recorded.length}`,
    );
  }
  got.forEach((message, j) => {
    const want = recorded[j]!;
    if (message.role === want.role && message.content === want.content) return;
    const [g, w] = around(message.content, want.content);
    throw new ReplayDivergence(
      `turn ${at}: message ${j} (${message.role}) differs from the recording\n  got:      ${g}\n  recorded: ${w}`,
    );
  });
}

/**
 * Deps that play a recording back. Each model call must send the recorded messages, so a
 * changed prompt or observation shows up, and gets the recorded reply. Each `execute()`
 * call must match the recorded one, and gets the recorded result.
 */
export function replayDeps({ turns, clock }: Recording): {
  deps: AgentDeps;
  remaining: () => number;
} {
  let next = 0;
  let tick = 0;
  let seen = 0;

  const take = <T extends Turn['type']>(type: T, doing: string): Extract<Turn, { type: T }> => {
    const turn = turns[next];
    if (turn?.type !== type) {
      throw new ReplayDivergence(
        `turn ${next}: the loop ${doing}, but the transcript ${describeTurn(turn)}`,
      );
    }
    next += 1;
    return turn as Extract<Turn, { type: T }>;
  };

  return {
    remaining: () => turns.length - next,
    deps: {
      model: {
        complete(messages) {
          const at = next;
          const turn = take('model', 'called the model');
          checkSent(at, messages.slice(seen), turn.sent);
          seen = messages.length;
          return Promise.resolve(turn.reply);
        },
      },
      execute(call) {
        const at = next;
        const turn = take('execute', `ran ${call.kind}`);
        if (!sameCall(call, turn.call)) {
          throw new ReplayDivergence(
            `turn ${at}: the loop ran a different call\n  got:      ${JSON.stringify(call)}\n  recorded: ${JSON.stringify(turn.call)}`,
          );
        }
        return Promise.resolve(turn.result);
      },
      // Past the recorded readings, time stands still, so the limit can't fire early.
      now() {
        const t = clock[Math.min(tick, clock.length - 1)] ?? 0;
        tick += 1;
        return t;
      },
    },
  };
}
