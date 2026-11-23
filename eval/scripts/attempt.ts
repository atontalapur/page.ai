// One eval attempt in real sandboxes: break.sh and the agent at one tier, then check.sh
// on the agent's diff in a second sandbox, which the runner starts while it plays on.
// An ops scenario's bug is in the live app instead (prepareOpsRun planted it), so its
// sandbox is clean, Tier 3 gets ops tools on that app, and check.sh runs on the host
// against it as soon as the agent stops.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { budgetFor, isLowConfidence, runAgent, scoreRun } from '@page/agent';
import type { Confidence } from '@page/contracts';
import type { ModelClient } from '@page/model-client';
import {
  DEFAULT_TIMEOUT_MS,
  DockerExecRunner,
  execute,
  FakeGitHub,
  FakeOps,
  GitHubHostTools,
  hostToolsFor,
  InMemoryAuditSink,
  OpsHostTools,
  StepLog,
} from '@page/toolkit';
import { evalApprove } from '../src/approve.ts';
import type { Attempt } from '../src/results.ts';
import { AttemptError, ProviderError, type AgentAttempt, type AttemptFn } from '../src/runner.ts';
import type { Scenario } from '../src/scenario.ts';
import type { LiveApp } from './host.ts';
import { checkLive, opsApi } from './ops-run.ts';
import {
  agentDiff,
  changedPaths,
  checkInFreshSandbox,
  plantBug,
  shellIn,
  startSandboxAsync,
  stopSandboxAsync,
} from './sandbox.ts';

/** The runner dropped the run while this attempt played. */
const dropped = (costUsd: number) => new AttemptError('stopped: the run was dropped', costUsd);

interface Scripts {
  breakScript: string;
  checkScript: string;
}

export function dockerAttempt(
  image: string,
  model: ModelClient,
  { liveApp }: { liveApp?: LiveApp } = {},
): AttemptFn {
  // Every tier and run of a scenario uses the same two scripts. An ops scenario plants
  // nothing in the sandbox, and its check.sh runs on the host from its file.
  const scripts = new Map<string, Promise<Scripts>>();
  const scriptsFor = (scenario: Scenario) => {
    if (scenario.kind === 'ops') return Promise.resolve({ breakScript: 'true', checkScript: '' });
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
  return async (scenario, tier, costLimitUsd, signal): Promise<AgentAttempt> => {
    const app = scenario.kind === 'ops' ? liveApp : undefined;
    if (scenario.kind === 'ops' && app === undefined) {
      throw new Error(`${scenario.id} is an ops scenario, and no live app is set`);
    }
    const { breakScript, checkScript } = await scriptsFor(scenario);
    // Set once the agent has run. Anything that fails after that reports it, so the
    // runner charges the budget what was really spent.
    let agentCostUsd: number | undefined;
    try {
      if (signal.aborted) throw dropped(0);
      const startedAt = Date.now();
      const name = await startSandboxAsync(image);
      // Removing the container ends a running command; the signal ends the model call.
      const stop = () => void stopSandboxAsync(name);
      signal.addEventListener('abort', stop, { once: true });
      let agent: Omit<Attempt, 'checkPassed'>;
      try {
        if (signal.aborted) throw dropped(0);
        const sh = shellIn(name);
        const baseline = await plantBug(sh, breakScript);

        const runner = new DockerExecRunner({ container: name });
        const issueId = randomUUID();
        const runId = randomUUID();
        const sink = new InMemoryAuditSink();
        const steps = new StepLog({ sink, issueId, runId });
        // From Tier 2 the agent pushes and opens a PR. An eval run must not touch the real
        // demo repo, so those go to an in-memory GitHub.
        const github =
          tier >= 2
            ? new GitHubHostTools({ github: new FakeGitHub(), workspace: runner, issueId, runId })
            : undefined;
        // Tier 3 gets the ops tools: on the live app for an ops scenario, and in memory for a
        // code scenario, whose bug isn't in any app's settings.
        const ops =
          tier >= 3
            ? new OpsHostTools({ ops: app ? opsApi(app) : new FakeOps(), signal })
            : undefined;
        const hostTools = hostToolsFor(tier, { github, ops });

        const run = await runAgent(
          { task: scenario.meta.report, tier },
          {
            model,
            signal,
            execute: (call, { timeoutMs = Infinity, thought }) =>
              execute(call, {
                tier,
                runner,
                steps,
                timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, timeoutMs),
                ...(hostTools === undefined ? {} : { hostTools }),
                // No one watches an eval run, so its gated ops calls are approved at once.
                approve: evalApprove,
                ...(thought === undefined ? {} : { thought }),
              }),
          },
          {
            costLimitUsd: costLimitUsd,
            // The container's wall clock started with it; at least 1 ms, since 0 is no limit.
            wallTimeLimitMs: Math.max(
              1,
              budgetFor(tier).wallTimeLimitMs - (Date.now() - startedAt),
            ),
          },
        );
        agentCostUsd = run.costUsd;
        // The runner dropped the run; the sandbox may already be gone.
        if (signal.aborted) throw dropped(run.costUsd);
        // A provider failure isn't the agent paging anyone. The runner drops the run.
        if (run.exitStatus === 'model_error') {
          const kind = run.error?.kind ?? 'unknown';
          throw new ProviderError(kind, run.error?.message ?? 'no detail', run.costUsd);
        }
        const diff = await agentDiff(sh, baseline);
        // Scored as the daemon scores a submitted run (apps/node/src/run/run-fix-job.ts), with
        // the same ops-only test: the live app changed, no PR, and no file changed.
        let confidence: Confidence | null = null;
        if (run.exitStatus === 'submitted') {
          const changedFiles = await changedPaths(sh, baseline);
          const opsOnly =
            ops?.changedApp === true && github?.prUrl == null && changedFiles?.length === 0;
          confidence = scoreRun({ steps: sink.steps, changedFiles, opsOnly });
        }
        agent = {
          tier,
          exitStatus: run.exitStatus,
          prOpened: github?.prUrl != null,
          modelCalls: run.modelCalls,
          costUsd: run.costUsd,
          durationMs: Date.now() - startedAt,
          steps: sink.steps.length,
          blockedSteps: sink.steps.filter((s) => !s.allowed).length,
          diff,
          confidence,
          lowConfidence: isLowConfidence(confidence, tier),
        };
      } finally {
        signal.removeEventListener('abort', stop);
        await stopSandboxAsync(name);
      }

      // The live app holds the outcome, and the next tier may change it, so the check runs
      // now rather than alongside that tier.
      if (app !== undefined) {
        const passed = await checkLive(scenario, app, signal);
        return { agent, check: () => Promise.resolve(passed) };
      }
      // check.sh never enters the agent's sandbox. It runs on every outcome, so an
      // escalated patch that already works is counted.
      return {
        agent,
        check: (checkSignal) =>
          checkInFreshSandbox(image, { breakScript, checkScript }, agent.diff, checkSignal),
      };
    } catch (error) {
      if (agentCostUsd === undefined || error instanceof AttemptError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AttemptError(message, agentCostUsd, { cause: error });
    }
  };
}
