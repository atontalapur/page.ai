// One eval attempt in a real sandbox: break.sh, the agent at one tier, then check.sh.
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
import type { AttemptFn } from '../src/runner.ts';
import { shellIn, startSandbox, stopSandbox } from './sandbox.ts';

export function dockerAttempt(image: string, model: ModelClient): AttemptFn {
  return async (scenario, tier, costLimitUsd): Promise<Attempt> => {
    const [breakScript, checkScript] = await Promise.all(
      ['break.sh', 'check.sh'].map((f) => readFile(join(scenario.dir, f), 'utf8')),
    );
    const startedAt = Date.now();
    const name = startSandbox(image);
    try {
      const sh = shellIn(name);
      const broke = await sh(breakScript!);
      if (broke.code !== 0) throw new Error(`${scenario.id}: break.sh exited ${broke.code}`);

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

      // check.sh goes over stdin after the run, so the agent never sees it. It runs on
      // every outcome, so an escalated patch that already works is counted.
      const check = await sh(checkScript!);
      const diff = await sh('git diff --no-ext-diff --no-textconv');
      return {
        tier,
        exitStatus: run.exitStatus,
        checkPassed: check.code === 0,
        prOpened: hostTools?.prUrl != null,
        modelCalls: run.modelCalls,
        costUsd: run.costUsd,
        durationMs: Date.now() - startedAt,
        steps: sink.steps.length,
        blockedSteps: sink.steps.filter((s) => !s.allowed).length,
        diff: diff.code === 0 ? diff.output : '',
      };
    } finally {
      stopSandbox(name);
    }
  };
}
