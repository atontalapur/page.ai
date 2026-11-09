// One eval attempt in real sandboxes: break.sh and the agent at one tier, then check.sh
// on the agent's diff in a second sandbox, which the runner starts while it plays on.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_AGENT_CONFIG, runAgent } from '@page/agent';
import type { ModelClient } from '@page/model-client';
import {
  DEFAULT_TIMEOUT_MS,
  DockerExecRunner,
  execute,
  FakeGitHub,
  GitHubHostTools,
  InMemoryAuditSink,
  StepLog,
} from '@page/toolkit';
import type { Attempt } from '../src/results.ts';
import { AttemptError, ProviderError, type AgentAttempt, type AttemptFn } from '../src/runner.ts';
import type { Scenario } from '../src/scenario.ts';
import {
  agentDiff,
  checkInFreshSandbox,
  plantBug,
  shellIn,
  startSandboxAsync,
  stopSandboxAsync,
} from './sandbox.ts';

interface Scripts {
  breakScript: string;
  checkScript: string;
}

export function dockerAttempt(image: string, model: ModelClient): AttemptFn {
  // Every tier and run of a scenario uses the same two scripts.
  const scripts = new Map<string, Promise<Scripts>>();
  const scriptsFor = (scenario: Scenario) => {
    let read = scripts.get(scenario.dir);
    if (read === undefined) {
      read = Promise.all(
        ['break.sh', 'check.sh'].map((f) => readFile(join(scenario.dir, f), 'utf8')),
      ).then(([breakScript, checkScript]) => ({
        breakScript: breakScript!,
        checkScript: checkScript!,
      }));
      scripts.set(scenario.dir, read);
    }
    return read;
  };

  // Async start and stop: several attempts and checks run at once, and a blocking docker
  // call would stall them all.
  return async (scenario, tier, costLimitUsd): Promise<AgentAttempt> => {
    const { breakScript, checkScript } = await scriptsFor(scenario);
    // Set once the agent has run. Anything that fails after that reports it, so the
    // runner charges the budget what was really spent.
    let agentCostUsd: number | undefined;
    try {
      const startedAt = Date.now();
      const name = await startSandboxAsync(image);
      let agent: Omit<Attempt, 'checkPassed'>;
      try {
        const sh = shellIn(name);
        const baseline = await plantBug(sh, breakScript);

        const runner = new DockerExecRunner({ container: name });
        const issueId = randomUUID();
        const runId = randomUUID();
        const sink = new InMemoryAuditSink();
        const steps = new StepLog({ sink, issueId, runId });
        // From Tier 2 the agent pushes and opens a PR. An eval run must not touch the real
        // demo repo, so those go to an in-memory GitHub.
        const hostTools =
          tier >= 2
            ? new GitHubHostTools({ github: new FakeGitHub(), workspace: runner, issueId, runId })
            : undefined;

        const run = await runAgent(
          { task: scenario.meta.report, tier },
          {
            model,
            execute: (call, { timeoutMs = Infinity }) =>
              execute(call, {
                tier,
                runner,
                steps,
                timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, timeoutMs),
                ...(hostTools === undefined ? {} : { hostTools }),
              }),
          },
          {
            costLimitUsd: costLimitUsd,
            // The container's wall clock started with it; at least 1 ms, since 0 is no limit.
            wallTimeLimitMs: Math.max(
              1,
              DEFAULT_AGENT_CONFIG.wallTimeLimitMs - (Date.now() - startedAt),
            ),
          },
        );
        agentCostUsd = run.costUsd;
        // A provider failure isn't the agent paging anyone. The runner drops the run.
        if (run.exitStatus === 'model_error') {
          const kind = run.error?.kind ?? 'unknown';
          throw new ProviderError(kind, run.error?.message ?? 'no detail', run.costUsd);
        }
        agent = {
          tier,
          exitStatus: run.exitStatus,
          prOpened: hostTools?.prUrl != null,
          modelCalls: run.modelCalls,
          costUsd: run.costUsd,
          durationMs: Date.now() - startedAt,
          steps: sink.steps.length,
          blockedSteps: sink.steps.filter((s) => !s.allowed).length,
          diff: await agentDiff(sh, baseline),
        };
      } finally {
        await stopSandboxAsync(name);
      }

      // check.sh never enters the agent's sandbox. It runs on every outcome, so an
      // escalated patch that already works is counted.
      return {
        agent,
        check: () => checkInFreshSandbox(image, { breakScript, checkScript }, agent.diff),
      };
    } catch (error) {
      if (agentCostUsd === undefined || error instanceof AttemptError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AttemptError(message, agentCostUsd, { cause: error });
    }
  };
}
