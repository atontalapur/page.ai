import type { ChatMessage, ModelClient, ModelError } from '@page/model-client';
import type { ExecErr, ExecOk, Result, ToolCall } from '@page/toolkit';
import { parseAction } from './actions.ts';
import {
  formatErrorPrompt,
  instancePrompt,
  observationPrompt,
  systemPrompt,
  type AgentTask,
} from './prompts.ts';

/** toolkit's `execute()` with the tier and runner already bound. */
export type ExecuteFn = (call: ToolCall) => Promise<Result<ExecOk, ExecErr>>;

export interface AgentDeps {
  model: ModelClient;
  execute: ExecuteFn;
  /** Milliseconds; injectable so tests control the wall clock. */
  now?: () => number;
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

// Upstream defaults to no step limit and $3. A Tier 1 fix should be cheap, and the sandbox
// kills the container at 15 minutes, so stop a little before that.
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  stepLimit: 40,
  costLimitUsd: 0.5,
  wallTimeLimitMs: 14 * 60 * 1000,
  maxConsecutiveFormatErrors: 3,
};

export type ExitStatus =
  'submitted' | 'step_limit' | 'cost_limit' | 'time_limit' | 'format_errors' | 'model_error';

export interface AgentRun {
  exitStatus: ExitStatus;
  messages: ChatMessage[];
  modelCalls: number;
  costUsd: number;
  /** Set when exitStatus is `model_error`. */
  error?: ModelError;
}

const reached = (limit: number, value: number) => limit > 0 && value >= limit;

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
  const config = { ...DEFAULT_AGENT_CONFIG, ...overrides };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: instancePrompt(task) },
  ];
  let modelCalls = 0;
  let costUsd = 0;
  let formatErrors = 0;

  const finish = (exitStatus: ExitStatus, error?: ModelError): AgentRun => ({
    exitStatus,
    messages,
    modelCalls,
    costUsd,
    ...(error === undefined ? {} : { error }),
  });

  for (;;) {
    if (reached(config.stepLimit, modelCalls)) return finish('step_limit');
    if (reached(config.costLimitUsd, costUsd)) return finish('cost_limit');
    if (reached(config.wallTimeLimitMs, now() - startedAt)) return finish('time_limit');

    const reply = await deps.model.complete(messages);
    if (!reply.ok) return finish('model_error', reply.error);
    modelCalls += 1;
    costUsd += reply.completion.costUsd;
    messages.push({ role: 'assistant', content: reply.completion.content });

    const parsed = parseAction(reply.completion.content);
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
    const result = await deps.execute(parsed.action.call);
    messages.push({ role: 'user', content: observationPrompt(result) });
  }
}
