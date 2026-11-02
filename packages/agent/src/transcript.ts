import type { CompletionResult } from '@page/model-client';
import type { ExecErr, ExecOk, Result, ToolCall } from '@page/toolkit';
import type { AgentConfig, AgentDeps, ExitStatus } from './agent.ts';
import type { AgentTask } from './prompts.ts';

/** One thing the loop did with the outside world, in the order it happened. */
export type Turn =
  | { type: 'model'; reply: CompletionResult }
  | { type: 'execute'; call: ToolCall; result: Result<ExecOk, ExecErr> };

export interface Recording {
  turns: Turn[];
  /** Every `now()` reading the loop took, so a run that hit the time limit replays too. */
  clock: number[];
}

export const TRANSCRIPT_VERSION = 1;

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
  return {
    turns,
    clock,
    deps: {
      model: {
        async complete(messages) {
          const reply = await deps.model.complete(messages);
          turns.push({ type: 'model', reply });
          return reply;
        },
      },
      async execute(call) {
        const result = await deps.execute(call);
        turns.push({ type: 'execute', call, result });
        return result;
      },
      now() {
        const t = now();
        clock.push(t);
        return t;
      },
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
  return (
    b.kind === 'edit' && a.path === b.path && a.oldText === b.oldText && a.newText === b.newText
  );
}

const describeTurn = (turn: Turn | undefined) =>
  turn === undefined ? 'has ended' : `has an ${turn.type}`;

/**
 * Deps that play a recording back: the model answers with the recorded replies and
 * `execute()` checks each call against the recorded one before returning its result.
 */
export function replayDeps({ turns, clock }: Recording): {
  deps: AgentDeps;
  remaining: () => number;
} {
  let next = 0;
  let tick = 0;

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
        complete: () => Promise.resolve(take('model', 'called the model').reply),
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
