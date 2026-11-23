import { budgetFor, runAgent, type AgentConfig, type ExecuteFn } from '@page/agent';
import { MAX_RUN_DIFF_CHARS, type Tier } from '@page/contracts';
import type { ModelClient } from '@page/model-client';
import {
  DEFAULT_TIMEOUT_MS,
  execute,
  GitHubHostTools,
  hostToolsFor,
  OpsHostTools,
  SAFE_GIT,
  StepLog,
  type AuditSink,
  type GitHub,
  type OpsApi,
} from '@page/toolkit';
import type { Logger } from 'pino';
import type { ClaimedJob } from '../jobs/job-source.ts';
import type { OrchestratorLink } from '../link/link.ts';
import type { Sandbox, Sandboxes } from '../sandbox/sandbox.ts';
import type { OpsLock, ReleaseOps } from './ops-lock.ts';
import { finishedEvent, type RunEnd, type RunFinished } from './outcome.ts';
import type { RunResults } from './results.ts';
import { StreamingAuditSink } from './streaming-sink.ts';

// The agent's diff, read after it submits. It goes to the UI, so it needn't be complete.
const DIFF_TIMEOUT_MS = 30_000;

export interface RunDeps {
  sandboxes: Sandboxes;
  /** The steps table. Every execute() call writes to it before anything is streamed. */
  sink: AuditSink;
  link: OrchestratorLink;
  /** The run_finished queue: how the orchestrator learns how the run ended. */
  results: RunResults;
  model: ModelClient;
  /**
   * The demo repo. With it, the run gets the Tier 2 host tools, which execute() still
   * refuses below Tier 2. Without it, every host tool call is refused.
   */
  github?: GitHub;
  /**
   * The live demo app's ops API. With it, a Tier 3 run gets the ops tools; runs below Tier 3
   * never get them. Without it, every ops tool call is refused.
   */
  ops?: OpsApi;
  /**
   * Claims the live app for a Tier 3 run, so no other run or eval changes it meanwhile. While
   * someone else holds it, the run's ops calls are refused. Without it, nothing is claimed.
   */
  opsLock?: OpsLock;
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
 * Every way out sends the result twice: `node.run.finished` on the link for the UI, and a
 * `run_finished` job the orchestrator records it from.
 *
 * Resolves for every run outcome, failures included. It rejects only if cleanup or the
 * link breaks, or the result can't be queued. pg-boss then fails the job and dead letters
 * it, and the orchestrator fails the issue unless the result was queued after all.
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
  const claimedAt = new Date(now()).toISOString();
  let githubTools: GitHubHostTools | undefined;
  let opsTools: OpsHostTools | undefined;
  let releaseOps: ReleaseOps | undefined;
  let diff: string | null = null;
  let opsOnly = false;

  const finish = async (end: RunEnd): Promise<RunFinished> => {
    const event = finishedEvent(runId, tier, end, tried, githubTools?.prUrl ?? null, opsOnly);
    deps.link.send('node.run.finished', event);
    await deps.results.send({
      v: 1,
      issueId,
      tier,
      startedAt: claimedAt,
      finishedAt: new Date(now()).toISOString(),
      // Only a submitted run's diff is the patch; a later kill or expiry voids it.
      diff: event.status === 'succeeded' ? diff : null,
      result: event,
    });
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
    return await finish(stoppedEnd() ?? { kind: 'sandbox_failed', message: String(error) });
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
      githubTools = new GitHubHostTools({
        github: deps.github,
        workspace: sandbox.runner,
        issueId,
        runId,
        // The host tools send nothing to GitHub once the run is stopped.
        signal: stopped,
        ...(job.escalationNote === undefined ? {} : { escalationNote: job.escalationNote }),
      });
    }
    // Built at Tier 3 only, once the run holds the app. The signal stops any further
    // request to the live app once the run is stopped.
    if (tier >= 3 && deps.ops !== undefined) {
      const claim = await claimOps(deps.opsLock, logger);
      releaseOps = claim.release;
      opsTools = new OpsHostTools({
        ops: deps.ops,
        signal: stopped,
        ...(claim.refusal === undefined ? {} : { refusal: claim.refusal }),
      });
    }
    const hostTools = hostToolsFor(tier, { github: githubTools, ops: opsTools });
    const run: ExecuteFn = (call, { timeoutMs = Infinity, thought }) =>
      execute(call, {
        tier,
        runner: sandbox.runner,
        steps,
        timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, timeoutMs),
        ...(hostTools === undefined ? {} : { hostTools }),
        ...(thought === undefined ? {} : { thought }),
      });

    // runAgent applies the tier's escalation threshold. The container's wall clock started
    // with it, so the agent's wall budget starts there too. At least 1 ms: the agent reads
    // 0 as no limit.
    const wallTimeLimitMs = deps.agentConfig?.wallTimeLimitMs ?? budgetFor(tier).wallTimeLimitMs;
    const config: Partial<AgentConfig> = {
      ...deps.agentConfig,
      ...(wallTimeLimitMs > 0
        ? { wallTimeLimitMs: Math.max(1, wallTimeLimitMs - (now() - startedAt)) }
        : {}),
    };

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
      diff = await sendDiff(sandbox, runId, deps.link, logger);
      opsOnly = await isOpsOnly(sandbox, opsTools, githubTools?.prUrl ?? null, diff, logger);
    }
    // A kill or expiry that lands after the agent returned (say during sendDiff) still
    // ends the run, and removing the sandbox may have cost it the diff.
    const final = stoppedEnd() ?? end;
    if (githubTools !== undefined) {
      await closeUnfinishedPr(githubTools, final, runId, tier, logger);
    }
    if (opsTools !== undefined) await undoUnfinishedOps(opsTools, final, logger);
    // Awaited here, so the result is queued before the sandbox goes in `finally`.
    return await finish(final);
  } finally {
    stopped.removeEventListener('abort', onAbort);
    try {
      // Try again if the removal on abort failed, so cleanup still runs on every path.
      if (!(await (removing ?? Promise.resolve(false)))) await deps.sandboxes.stop(sandbox);
      logger.info({ container: sandbox.name }, 'sandbox removed');
    } finally {
      // After the sandbox, so a slow unlock doesn't hold it up. Undo has already run.
      await releaseOps?.();
    }
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

/**
 * Claims the live app for the run. A claim held elsewhere, or one that can't be taken, gives
 * the run a refusal for each ops call instead, which the agent sees and can escalate on.
 */
async function claimOps(
  lock: OpsLock | undefined,
  logger: Logger,
): Promise<{ release?: ReleaseOps; refusal?: string }> {
  if (lock === undefined) return {};
  try {
    const release = await lock.tryAcquire();
    if (release !== null) return { release };
    logger.warn('another run or eval holds the live app; refusing this run its ops calls');
    return {
      refusal: 'the live app is in use by another run or eval, so this run may not change it',
    };
  } catch (error) {
    logger.error({ err: error }, 'could not claim the live app; refusing this run its ops calls');
    return { refusal: `could not claim the live app: ${String(error)}` };
  }
}

/**
 * A Tier 3 run that didn't succeed puts back the overrides it changed, so the tier above
 * starts from the app this run found. Best effort, like closeUnfinishedPr: a change that
 * won't go back is logged, and the run still reported.
 */
async function undoUnfinishedOps(tools: OpsHostTools, end: RunEnd, logger: Logger): Promise<void> {
  if (end.kind === 'agent' && end.run.exitStatus === 'submitted') return;
  try {
    const { restored, unknown, restarted, failed } = await tools.undo();
    if (failed.length > 0) {
      logger.warn(
        { failed },
        'could not put back all the ops changes of a run that did not succeed',
      );
    }
    if (restored.length > 0 || restarted) {
      logger.info(
        { restored, restarted },
        'put back the ops changes of a run that did not succeed',
      );
    }
    if (unknown.length > 0) {
      logger.warn(
        { settings: unknown },
        'ops changes that never answered may have landed; left as they are',
      );
    }
  } catch (error) {
    logger.warn({ err: error }, 'could not put back the ops changes of a run that did not succeed');
  }
}

/**
 * Whether a submitted run's fix is its ops changes alone: it changed the live app (Tier 3),
 * opened no PR, and left the workspace as it found it, new files included. A null diff
 * can't say so, since a diff that couldn't be read or is over the cap is null too, and
 * `git diff` leaves out new files, so this asks `git status`. Anything it can't confirm
 * counts as a code change, which goes to review.
 */
async function isOpsOnly(
  sandbox: Sandbox,
  opsTools: OpsHostTools | undefined,
  prUrl: string | null,
  diff: string | null,
  logger: Logger,
): Promise<boolean> {
  if (opsTools?.changedApp !== true || prUrl !== null || (diff ?? '') !== '') return false;
  try {
    const result = await sandbox.runner.run({
      command: `${SAFE_GIT} status --porcelain=v1 -z --untracked-files=all`,
      timeoutMs: DIFF_TIMEOUT_MS,
    });
    if (result.status === 'exited' && result.exitCode === 0) return result.stdout === '';
    logger.warn({ result: result.status }, 'git status failed; sending the ops fix to review');
  } catch (error) {
    logger.warn({ err: error }, 'git status failed; sending the ops fix to review');
  }
  return false;
}

/**
 * Best effort: a diff that can't be read is logged, and the run still finishes. Returns the
 * diff for the run_finished job, or null when it couldn't be read or is over the job's cap.
 */
async function sendDiff(
  sandbox: Sandbox,
  runId: string,
  link: OrchestratorLink,
  logger: Logger,
): Promise<string | null> {
  try {
    // No external diff or textconv driver: the repo's config and attributes are the agent's.
    const result = await sandbox.runner.run({
      command: `${SAFE_GIT} diff --no-ext-diff --no-textconv`,
      timeoutMs: DIFF_TIMEOUT_MS,
    });
    if (result.status === 'exited' && result.exitCode === 0) {
      link.send('node.diff', { v: 1, runId, diff: result.stdout });
      if (result.stdout.length <= MAX_RUN_DIFF_CHARS) return result.stdout;
      logger.warn({ chars: result.stdout.length }, 'diff is over the cap; not recorded');
      return null;
    }
    logger.warn({ result: result.status }, 'git diff failed; no diff sent');
  } catch (error) {
    logger.warn({ err: error }, 'git diff failed; no diff sent');
  }
  return null;
}
