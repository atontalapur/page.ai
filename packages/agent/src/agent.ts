import type { ChatMessage, ModelClient, ModelError } from '@page/model-client';
import type { ExecErr, ExecOk, Result, ToolCall } from '@page/toolkit';
import { parseAction, thoughtOf } from './actions.ts';
import { onCallPrompt, takeReply, type Inbox } from './oncall.ts';
import { budgetFor } from './threshold.ts';
import {
  formatErrorPrompt,
  instancePrompt,
  observationPrompt,
  systemPrompt,
  type AgentTask,
} from './prompts.ts';

export interface ExecuteOptions {
  /** The time left in the run. The command must not outlive it; unset means no limit. */
  timeoutMs?: number;
  /** What the model said before asking for the call, for the audit log. */
  thought?: string;
}

/** toolkit's `execute()` with the tier and runner already bound. */
export type ExecuteFn = (
  call: ToolCall,
  options: ExecuteOptions,
) => Promise<Result<ExecOk, ExecErr>>;

export interface AgentDeps {
  model: ModelClient;
  execute: ExecuteFn;
  /** Milliseconds; injectable so tests control the wall clock. */
  now?: () => number;
  /**
   * Stops the run, such as when it is killed. An in-flight model call is cancelled; a
   * running command is the caller's to stop. The run then ends as `aborted`.
   */
  signal?: AbortSignal;
  /**
   * Messages from people watching the run. Each one is shown after the result of the last
   * action, before the next model call, and the reply to that call answers it and takes an
   * action, so a message costs no model call of its own. Without an inbox, or while it holds
   * nothing, the loop sends exactly what it sent before there was one.
   */
  inbox?: Inbox;
}

export interface AgentConfig {
  /** Model calls before the run stops. 0 means no limit. */
  stepLimit: number;
  /** Stop once spending reaches this. 0 means no limit. */
  costLimitUsd: number;
  /** Wall clock budget. 0 means no limit. */
  wallTimeLimitMs: number;
  /** Badly formatted replies in a row before the run stops. 0 means no limit. */
  maxConsecutiveFormatErrors: number;
}

// Upstream defaults to no step limit and $3. The step, cost and time limits are the
// escalation threshold (threshold.ts); runAgent uses the task's tier's, and this holds
// Tier 1's for callers that need a config without one.
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  ...budgetFor(1),
  maxConsecutiveFormatErrors: 3,
};

export type ExitStatus =
  | 'submitted'
  | 'step_limit'
  | 'cost_limit'
  | 'time_limit'
  | 'format_errors'
  | 'model_error'
  | 'audit_failed'
  | 'aborted';

export interface AgentRun {
  exitStatus: ExitStatus;
  messages: ChatMessage[];
  modelCalls: number;
  costUsd: number;
  /** Set when exitStatus is `model_error`. */
  error?: ModelError;
  /** Set when exitStatus is `audit_failed`: why the step couldn't be written. */
  auditError?: string;
}

const reached = (limit: number, value: number) => limit > 0 && value >= limit;

const withTimeout = (timeoutMs: number | undefined) =>
  timeoutMs === undefined ? {} : { timeoutMs };

const withSignal = (signal: AbortSignal | undefined) => (signal === undefined ? {} : { signal });

/**
 * The mini-swe-agent loop: ask the model, run the one action it gives, show it the
 * result, repeat until it submits or a limit is hit. The model and `execute()` are the
 * only ways out.
 */
export async function runAgent(
  task: AgentTask,
  deps: AgentDeps,
  overrides: Partial<AgentConfig> = {},
): Promise<AgentRun> {
  // The tier's escalation threshold. A caller's overrides win either way; the daemon and
  // the eval use them to shorten the wall clock by the time the sandbox took to start.
  const config = { ...DEFAULT_AGENT_CONFIG, ...budgetFor(task.tier ?? 1), ...overrides };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(task.tier, task.rollback) },
    { role: 'user', content: instancePrompt(task) },
  ];
  let modelCalls = 0;
  let costUsd = 0;
  let formatErrors = 0;

  const outOfTime = () => reached(config.wallTimeLimitMs, now() - startedAt);
  // A model call or command started near the end must not run past it, or the run can
  // outlive its sandbox.
  const timeLeft = () =>
    config.wallTimeLimitMs > 0 ? config.wallTimeLimitMs - (now() - startedAt) : undefined;

  const finish = (exitStatus: ExitStatus, error?: ModelError): AgentRun => ({
    exitStatus,
    messages,
    modelCalls,
    costUsd,
    ...(error === undefined ? {} : { error }),
  });

  const aborted = () => deps.signal?.aborted === true;

  for (;;) {
    if (aborted()) return finish('aborted');
    if (reached(config.stepLimit, modelCalls)) return finish('step_limit');
    if (reached(config.costLimitUsd, costUsd)) return finish('cost_limit');
    if (outOfTime()) return finish('time_limit');

    const asked = deps.inbox?.take() ?? [];
    if (asked.length > 0) appendToTurn(messages, onCallPrompt(asked));
    const reply = await deps.model.complete(messages, {
      ...withTimeout(timeLeft()),
      ...withSignal(deps.signal),
    });
    // A call that came back is billed, even when the run was stopped while it was out.
    if (reply.ok) {
      modelCalls += 1;
      costUsd += reply.completion.costUsd;
    }
    if (aborted()) return finish('aborted');
    if (!reply.ok) {
      // A call the deadline cut short is the time limit, not a model failure.
      return outOfTime() ? finish('time_limit') : finish('model_error', reply.error);
    }
    messages.push({ role: 'assistant', content: reply.completion.content });

    // The answer goes back through the inbox; the action and thought are read from the rest.
    let content = reply.completion.content;
    if (asked.length > 0) {
      const answered = takeReply(content);
      deps.inbox?.answer(asked, answered.reply);
      content = answered.rest;
    }

    const parsed = parseAction(content);
    if (!parsed.ok) {
      formatErrors += 1;
      messages.push({
        role: 'user',
        content: formatErrorPrompt(parsed.error, reply.completion.finishReason),
      });
      if (reached(config.maxConsecutiveFormatErrors, formatErrors)) {
        return finish('format_errors');
      }
      continue;
    }
    formatErrors = 0;

    if (parsed.action.kind === 'submit') return finish('submitted');
    if (outOfTime()) return finish('time_limit');
    const thought = thoughtOf(content, reply.completion.reasoning);
    const result = await deps.execute(parsed.action.call, {
      ...withTimeout(timeLeft()),
      ...(thought === undefined ? {} : { thought }),
    });
    if (aborted()) return finish('aborted');
    // Nothing may run unaudited, so a step the log couldn't take ends the run.
    if (!result.ok && result.error.type === 'audit_failed') {
      return { ...finish('audit_failed'), auditError: result.error.message };
    }
    messages.push({ role: 'user', content: observationPrompt(result) });
  }
}

/**
 * Adds `text` to the last message. At a step boundary that is always the user's turn (the
 * task, an observation or a format error), so the roles still alternate as every provider
 * expects. A copy replaces it, so a caller holding the old message sees it unchanged.
 */
function appendToTurn(messages: ChatMessage[], text: string): void {
  const last = messages.at(-1)!;
  messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${text}` };
}
