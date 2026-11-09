import { DEFAULT_AGENT_CONFIG, runAgent, type AgentConfig, type ExecuteFn } from '@page/agent';
import type { Tier } from '@page/contracts';
import type { ModelClient } from '@page/model-client';
import {
  DEFAULT_TIMEOUT_MS,
  execute,
  GitHubHostTools,
  SAFE_GIT,
  StepLog,
  type AuditSink,
  type GitHub,
} from '@page/toolkit';
import type { Logger } from 'pino';
import type { ClaimedJob } from '../jobs/job-source.ts';
import type { OrchestratorLink } from '../link/link.ts';
import type { Sandbox, Sandboxes } from '../sandbox/sandbox.ts';
import { finishedEvent, type RunEnd, type RunFinished } from './outcome.ts';
import { StreamingAuditSink } from './streaming-sink.ts';

// The agent's diff, read after it submits. It goes to the UI, so it needn't be complete.
const DIFF_TIMEOUT_MS = 30_000;

export interface RunDeps {
  sandboxes: Sandboxes;
  /** The steps table. Every execute() call writes to it before anything is streamed. */
  sink: AuditSink;
  link: OrchestratorLink;
  model: ModelClient;
  /**
   * The demo repo. With it, the run gets the Tier 2 host tools, which execute() still
   * refuses below Tier 2. Without it, every host tool call is refused.
   */
  github?: GitHub;
  logger: Logger;
  agentConfig?: Partial<AgentConfig>;
  /** Milliseconds; injectable so tests control the wall clock. */
  now?: () => number;
}

/**
 * Runs one fix job: starts the run's sandbox, runs the agent loop in the daemon with
 * every command going into the container through toolkit's execute(), streams each step
 * to the orchestrator, and reports how the run ended. The sandbox is removed on every
 * path out, and when the queue gives up on the job.
 *
 * `kill` stops the run the way a job expiry does: the in-flight model call is cancelled
 * and the sandbox removed at once. The run then finishes as `killed`.
 *
 * Resolves for every run outcome, failures included. It rejects only if cleanup or the
 * link itself breaks, which pg-boss then records on the job.
 */
export async function runFixJob(
  { job, signal }: ClaimedJob,
  deps: RunDeps,
  kill: AbortSignal = new AbortController().signal,
): Promise<RunFinished> {
  const { issueId, runId, tier } = job;
  const logger = deps.logger.child({ issueId, runId, tier });
  const now = deps.now ?? Date.now;
  const tried: string[] = [];
  let hostTools: GitHubHostTools | undefined;

  const finish = (end: RunEnd): RunFinished => {
    const event = finishedEvent(runId, tier, end, tried, hostTools?.prUrl ?? null);
    deps.link.send('node.run.finished', event);
    logger.info({ status: event.status }, 'run finished');
    return event;
  };

  if (job.report === undefined) return finish({ kind: 'no_report' });
  if (kill.aborted) return finish({ kind: 'killed' });

  // Either one stops the run; which one fired decides how it is reported.
  const stopped = AbortSignal.any([signal, kill]);
  const stoppedEnd = (): RunEnd | undefined => {
    if (kill.aborted) return { kind: 'killed' };
    if (signal.aborted) return { kind: 'expired' };
    return undefined;
  };

  const startedAt = now();
  let sandbox: Sandbox;
  try {
    sandbox = await deps.sandboxes.start(runId);
  } catch (error) {
    logger.error({ err: error }, 'sandbox did not start');
    return finish(stoppedEnd() ?? { kind: 'sandbox_failed', message: String(error) });
  }
  logger.info({ container: sandbox.name }, 'sandbox started');

  // Removing the container ends a running command; the signal ends the model call. The
  // removal is kept so cleanup below waits on it rather than racing a second `docker rm`.
  let removing: Promise<boolean> | undefined;
  const onAbort = () => {
    logger.warn(
      kill.aborted ? 'run killed; stopping the sandbox' : 'job expired; stopping the sandbox',
    );
    removing = deps.sandboxes.stop(sandbox).then(
      () => true,
      (error: unknown) => {
        logger.error({ err: error }, 'could not stop the sandbox');
        return false;
      },
    );
  };
  // A kill that arrived while the sandbox was starting has already fired.
  if (stopped.aborted) onAbort();
  else stopped.addEventListener('abort', onAbort, { once: true });

  try {
    const steps = new StepLog({
      sink: new StreamingAuditSink({
        inner: deps.sink,
        logger,
        onStep: (step) => {
          tried.push(step.input);
          deps.link.send('node.step', { v: 1, step });
        },
      }),
      issueId,
      runId,
      logger,
    });
    if (deps.github !== undefined) {
      hostTools = new GitHubHostTools({
        github: deps.github,
        workspace: sandbox.runner,
        issueId,
        runId,
        // The host tools send nothing to GitHub once the run is stopped.
        signal: stopped,
        ...(job.escalationNote === undefined ? {} : { escalationNote: job.escalationNote }),
      });
    }
    const run: ExecuteFn = (call, { timeoutMs = Infinity }) =>
      execute(call, {
        tier,
        runner: sandbox.runner,
        steps,
        timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, timeoutMs),
        ...(hostTools === undefined ? {} : { hostTools }),
      });

    // The container's wall clock started with it, so the agent's budget starts there too.
    // At least 1 ms: the agent reads 0 as no limit.
    const config = { ...DEFAULT_AGENT_CONFIG, ...deps.agentConfig };
    if (config.wallTimeLimitMs > 0) {
      config.wallTimeLimitMs = Math.max(1, config.wallTimeLimitMs - (now() - startedAt));
    }

    let end: RunEnd;
    try {
      const agentRun = await runAgent(
        { task: job.report, tier },
        { model: deps.model, execute: run, now, signal: stopped },
        config,
      );
      end = stoppedEnd() ?? { kind: 'agent', run: agentRun };
    } catch (error) {
      logger.error({ err: error }, 'run crashed');
      end = stoppedEnd() ?? { kind: 'crashed', message: String(error) };
    }

    if (end.kind === 'agent' && end.run.exitStatus === 'submitted') {
      await sendDiff(sandbox, runId, deps.link, logger);
    }
    // A kill or expiry that lands after the agent returned (say during sendDiff) still
    // ends the run, and removing the sandbox may have cost it the diff.
    const final = stoppedEnd() ?? end;
    if (hostTools !== undefined) await closeUnfinishedPr(hostTools, final, runId, tier, logger);
    return finish(final);
  } finally {
    stopped.removeEventListener('abort', onAbort);
    // Try again if the removal on abort failed, so cleanup still runs on every path.
    if (!(await (removing ?? Promise.resolve(false)))) await deps.sandboxes.stop(sandbox);
    logger.info({ container: sandbox.name }, 'sandbox removed');
  }
}

/**
 * A run that opened a PR and then didn't succeed closes it, so the tier above doesn't open
 * a second one next to it. Best effort: a PR that won't close is logged, and still reported.
 */
async function closeUnfinishedPr(
  hostTools: GitHubHostTools,
  end: RunEnd,
  runId: string,
  tier: Tier,
  logger: Logger,
): Promise<void> {
  if (end.kind === 'agent' && end.run.exitStatus === 'submitted') return;
  const pr = hostTools.pr;
  if (pr === null) return;
  const { status } = finishedEvent(runId, tier, end, []);
  const comment =
    `PageAgents closed this PR: run \`${runId}\` ended as ${status} before the fix was ` +
    'done, so this branch is not the fix. A later run opens its own PR.';
  try {
    await hostTools.closePr(comment);
    logger.info({ pr: pr.url }, 'closed the PR of a run that did not succeed');
  } catch (error) {
    logger.warn({ err: error, pr: pr.url }, 'could not close the PR of a run that did not succeed');
  }
}

/** Best effort: a diff that can't be read is logged, and the run still finishes. */
async function sendDiff(
  sandbox: Sandbox,
  runId: string,
  link: OrchestratorLink,
  logger: Logger,
): Promise<void> {
  try {
    // No external diff or textconv driver: the repo's config and attributes are the agent's.
    const result = await sandbox.runner.run({
      command: `${SAFE_GIT} diff --no-ext-diff --no-textconv`,
      timeoutMs: DIFF_TIMEOUT_MS,
    });
    if (result.status === 'exited' && result.exitCode === 0) {
      link.send('node.diff', { v: 1, runId, diff: result.stdout });
      return;
    }
    logger.warn({ result: result.status }, 'git diff failed; no diff sent');
  } catch (error) {
    logger.warn({ err: error }, 'git diff failed; no diff sent');
  }
}
