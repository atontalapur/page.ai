import {
  budgetFor,
  CONFIDENCE_THRESHOLD,
  runAgent,
  scoreRun,
  type AgentConfig,
  type ExecuteFn,
  type ScoredStep,
  type SubmittedRun,
} from '@page/agent';
import { MAX_RUN_DIFF_CHARS, type Confidence, type Tier } from '@page/contracts';
import type { ModelClient } from '@page/model-client';
import {
  APPROVAL_TOOLS,
  DEFAULT_TIMEOUT_MS,
  execute,
  GitHubHostTools,
  hostToolsFor,
  OpsHostTools,
  parseStatus,
  SAFE_GIT,
  StepLog,
  type AuditSink,
  type Deployer,
  KnowledgeHostTools,
  type GitHub,
  type GitHubToolCall,
  type OpsApi,
} from '@page/toolkit';
import type { Logger } from 'pino';
import type { ClaimedJob } from '../jobs/job-source.ts';
import type { OrchestratorLink } from '../link/link.ts';
import type { Sandbox, Sandboxes } from '../sandbox/sandbox.ts';
import { approvalArgs, type Approvals } from './approvals.ts';
import type { RunInbox } from './inbox.ts';
import type { OpsLock, ReleaseOps } from './ops-lock.ts';
import {
  finishedEvent,
  submitted,
  type RunEnd,
  type RunFacts,
  type RunFinished,
} from './outcome.ts';
import type { RunResults } from './results.ts';
import { StreamingAuditSink } from './streaming-sink.ts';

// The PR the daemon opens for a Tier 1 fix: its title, the report lines in its body, and
// how long each GitHub step gets.
const TIER1_PR_TITLE_CHARS = 100;
const TIER1_PR_REPORT_LINES = 40;
const TIER1_PR_TIMEOUT_MS = 60_000;

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
   * Builds a run's knowledge-graph tools, which reach the orchestrator. With it, every tier
   * gets kg.search, kg.read and kg.write; without it, the prompt leaves them out.
   */
  knowledge?: (run: { runId: string; signal: AbortSignal }) => KnowledgeHostTools;
  /**
   * Claims the live app for a Tier 3 run, so no other run or eval changes it meanwhile. While
   * someone else holds it, the run's ops calls are refused. Without it, nothing is claimed.
   */
  opsLock?: OpsLock;
  /**
   * The live app's deploys. With it and `ops`, a Tier 3 run also gets the rollback tools,
   * and its prompt offers them. Without it, they are refused as not set up on this node.
   */
  deployer?: Deployer;
  /**
   * Scores a submitted run; scoreRun from @page/agent unless a test swaps it. A score that
   * throws leaves the run unscored, and an unscored run never escalates on confidence.
   */
  score?: (run: SubmittedRun) => Confidence;
  /**
   * How the run asks a person before a gated ops tool runs (APPROVAL_TOOLS). Without it,
   * those calls are refused, so a node that can't ask never changes the live app.
   */
  approvals?: Approvals;
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
 * `inbox` holds the messages people on call send the run. The agent reads them at each step
 * boundary and answers in its next reply; once the agent loop returns, the inbox is ended,
 * so a message that comes later gets no answer (`submitted` after a submission).
 *
 * Resolves for every run outcome, failures included. It rejects only if cleanup or the
 * link breaks, or the result can't be queued. pg-boss then fails the job and dead letters
 * it, and the orchestrator fails the issue unless the result was queued after all.
 */
export async function runFixJob(
  { job, signal }: ClaimedJob,
  deps: RunDeps,
  kill: AbortSignal = new AbortController().signal,
  inbox?: RunInbox,
): Promise<RunFinished> {
  const { issueId, runId, tier } = job;
  const logger = deps.logger.child({ issueId, runId, tier });
  const now = deps.now ?? Date.now;
  const tried: string[] = [];
  const claimedAt = new Date(now()).toISOString();
  let githubTools: GitHubHostTools | undefined;
  let opsTools: OpsHostTools | undefined;
  let releaseOps: ReleaseOps | undefined;
  // Every step as it was recorded, for the score.
  const taken: ScoredStep[] = [];
  let diff: string | null = null;
  let opsOnly = false;
  let confidence: Confidence | null = null;
  const facts = (): RunFacts => ({ prUrl: githubTools?.prUrl ?? null, opsOnly, confidence });

  const finish = async (end: RunEnd): Promise<RunFinished> => {
    const event = finishedEvent(runId, tier, end, tried, facts());
    deps.link.send('node.run.finished', event);
    await deps.results.send({
      v: 1,
      issueId,
      tier,
      startedAt: claimedAt,
      finishedAt: new Date(now()).toISOString(),
      // Only a submitted run's diff is the patch, kept when its score sends it on too; a later
      // kill or expiry voids it.
      diff: submitted(end) ? diff : null,
      result: event,
    });
    logger.info({ status: event.status, confidence: event.confidence?.score }, 'run finished');
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
          taken.push(step);
          deps.link.send('node.step', { v: 1, step });
        },
      }),
      issueId,
      runId,
      logger,
    });
    const knowledgeTools = deps.knowledge?.({ runId, signal: stopped });
    if (deps.github !== undefined) {
      githubTools = new GitHubHostTools({
        github: deps.github,
        workspace: sandbox.runner,
        issueId,
        runId,
        // The host tools send nothing to GitHub once the run is stopped.
        signal: stopped,
        ...(job.escalationNote === undefined ? {} : { escalationNote: job.escalationNote }),
        // The run's knowledge written before this push now carries its commit.
        ...(knowledgeTools === undefined
          ? {}
          : {
              onPushed: async (sha: string) => {
                const stamped = await knowledgeTools.commit(sha).catch((error: unknown) => {
                  logger.warn({ err: error, sha }, 'could not record the knowledge commit');
                  return 0;
                });
                if (stamped > 0) logger.info({ sha, stamped }, 'knowledge commit recorded');
              },
            }),
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
        ...(deps.deployer === undefined ? {} : { deployer: deps.deployer }),
        ...(claim.refusal === undefined ? {} : { refusal: claim.refusal }),
      });
    }
    const hostTools = hostToolsFor(tier, {
      github: githubTools,
      ops: opsTools,
      knowledge: knowledgeTools,
    });
    // The prompt offers the rollback blocks only to a run that has the tool.
    const rollback = hostTools?.handles?.('ops.rollback') === true;
    // And says a person approves the run's changes to the live app only when one does: not
    // with AUTO_APPROVE_OPS, and not for a run with no gated tool to ask about.
    const personApproves =
      deps.approvals?.asksPerson === true &&
      [...APPROVAL_TOOLS].some((tool) => hostTools?.handles?.(tool) === true);
    // A kill or expiry ends a wait for approval as a refusal.
    const approve = deps.approvals?.forRun({
      runId,
      signal: stopped,
      args: (call) => approvalArgs(call, opsTools),
    });
    const run: ExecuteFn = (call, { timeoutMs = Infinity, thought }) =>
      execute(call, {
        tier,
        runner: sandbox.runner,
        steps,
        timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, timeoutMs),
        ...(hostTools === undefined ? {} : { hostTools }),
        ...(approve === undefined ? {} : { approve }),
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
        {
          task: job.report,
          tier,
          rollback,
          personApproves,
          knowledge: knowledgeTools !== undefined,
        },
        {
          model: deps.model,
          execute: run,
          now,
          signal: stopped,
          ...(inbox === undefined ? {} : { inbox }),
        },
        config,
      );
      end = stoppedEnd() ?? { kind: 'agent', run: agentRun };
    } catch (error) {
      logger.error({ err: error }, 'run crashed');
      end = stoppedEnd() ?? { kind: 'crashed', message: String(error) };
    }
    // The agent takes no more steps, so no message from now on gets an answer.
    inbox?.end(submitted(end) ? 'submitted' : 'run_ended');

    if (submitted(end)) {
      diff = await sendDiff(sandbox, runId, deps.link, logger);
      const changedFiles = await workspaceChanges(sandbox, logger);
      opsOnly = isOpsOnly(opsTools, githubTools?.prUrl ?? null, diff, changedFiles);
      confidence = scoreOrNull(
        deps.score ?? scoreRun,
        { steps: taken, changedFiles, opsOnly },
        logger,
      );
    }
    // A kill or expiry that lands after the agent returned (say during sendDiff) still
    // ends the run, and removing the sandbox may have cost it the diff.
    const final = stoppedEnd() ?? end;
    // A submitted run whose score sends it on didn't succeed either.
    const outcome = finishedEvent(runId, tier, final, [], facts());
    if (githubTools !== undefined) {
      await closeUnfinishedPr(githubTools, outcome, runId, tier, logger);
      if (tier === 1 && outcome.status === 'succeeded' && !outcome.opsOnly) {
        await openTier1Pr(githubTools, job.report, logger);
      }
    }
    if (opsTools !== undefined && outcome.status !== 'succeeded') {
      await undoUnfinishedOps(opsTools, logger);
    }
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
 * Tier 1 has no host tools, so its agent can't push. A Tier 1 fix that succeeded is pushed
 * and opened as a PR here instead, by the daemon, so the person approving it has something
 * to merge. Best effort: a push or PR that fails is logged, and the run keeps its patch.
 */
async function openTier1Pr(
  hostTools: GitHubHostTools,
  report: string,
  logger: Logger,
): Promise<void> {
  const title = `fix: ${report.split('\n')[0]!.trim()}`.slice(0, TIER1_PR_TITLE_CHARS);
  const body = [
    "The Tier 1 agent's fix for this report. Tier 1 can't push, so the daemon opened this PR.",
    '',
    '```',
    report.split('\n').slice(0, TIER1_PR_REPORT_LINES).join('\n'),
    '```',
  ].join('\n');
  const calls: GitHubToolCall[] = [
    { kind: 'host_tool', tool: 'git.pushBranch', message: title },
    { kind: 'host_tool', tool: 'github.openPr', title, body },
  ];
  for (const call of calls) {
    const result = await hostTools.run(call, TIER1_PR_TIMEOUT_MS).catch((error: unknown) => ({
      ok: false as const,
      output: String(error),
    }));
    if (!result.ok) {
      logger.warn({ tool: call.tool, output: result.output }, 'could not open the Tier 1 PR');
      return;
    }
  }
  logger.info({ pr: hostTools.prUrl }, 'opened the Tier 1 PR');
}

/**
 * A run that opened a PR and then didn't succeed closes it, so the tier above doesn't open
 * a second one next to it. That includes a run that submitted a fix with too low a score.
 * Best effort: a PR that won't close is logged, and still reported.
 */
async function closeUnfinishedPr(
  hostTools: GitHubHostTools,
  { status, confidence }: RunFinished,
  runId: string,
  tier: Tier,
  logger: Logger,
): Promise<void> {
  if (status === 'succeeded') return;
  const pr = hostTools.pr;
  if (pr === null) return;
  // Only a submitted run carries a score, so one here scored under the threshold.
  const why =
    confidence === null
      ? 'before the fix was done'
      : `with a fix that scored ${confidence.score.toFixed(2)} for confidence, under Tier ` +
        `${tier}'s threshold of ${CONFIDENCE_THRESHOLD[tier]}`;
  const comment =
    `PageAgents closed this PR: run \`${runId}\` ended as ${status} ${why}, so this branch ` +
    'is not the fix. A later run opens its own PR.';
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
 * starts from the app this run found. A run that submitted with too low a score didn't
 * succeed either. Best effort, like closeUnfinishedPr: a change that won't go back is logged,
 * and the run still reported. A rollback stays live and is logged, since rolling forward
 * would redeploy the build the run judged bad (see OpsHostTools.undo).
 */
async function undoUnfinishedOps(tools: OpsHostTools, logger: Logger): Promise<void> {
  try {
    const { restored, unknown, restarted, failed, rollback } = await tools.undo();
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
    if (rollback !== null) {
      logger.warn(
        { rollback },
        rollback.accepted
          ? "kept the rollback of a run that did not succeed; rolling forward is a person's call"
          : 'a rollback that never answered may have started; left as it is',
      );
    }
  } catch (error) {
    logger.warn({ err: error }, 'could not put back the ops changes of a run that did not succeed');
  }
}

/**
 * The paths `git status` shows changed in the workspace, new files included, or null when it
 * can't say. `git diff` leaves out new files, and its result is null for a diff over the cap
 * too, so the score and the ops-only check both ask `git status`.
 */
async function workspaceChanges(sandbox: Sandbox, logger: Logger): Promise<string[] | null> {
  try {
    const result = await sandbox.runner.run({
      command: `${SAFE_GIT} status --porcelain=v1 -z --untracked-files=all`,
      timeoutMs: DIFF_TIMEOUT_MS,
    });
    if (result.status === 'exited' && result.exitCode === 0) {
      return parseStatus(result.stdout).map((change) => change.path);
    }
    logger.warn({ result: result.status }, 'git status failed; the changed files are unknown');
  } catch (error) {
    logger.warn({ err: error }, 'git status failed; the changed files are unknown');
  }
  return null;
}

/**
 * Whether a submitted run's fix is its ops changes alone: it changed the live app (Tier 3),
 * opened no PR, and left the workspace as it found it, new files included. Anything it can't
 * confirm, such as a workspace git couldn't read, counts as a code change, which goes to
 * review.
 */
function isOpsOnly(
  opsTools: OpsHostTools | undefined,
  prUrl: string | null,
  diff: string | null,
  changedFiles: readonly string[] | null,
): boolean {
  return (
    opsTools?.changedApp === true &&
    prUrl === null &&
    (diff ?? '') === '' &&
    changedFiles?.length === 0
  );
}

/** The run's score, or null when scoring threw: the run then goes on unscored. */
function scoreOrNull(
  score: (run: SubmittedRun) => Confidence,
  run: SubmittedRun,
  logger: Logger,
): Confidence | null {
  try {
    return score(run);
  } catch (error) {
    logger.warn({ err: error }, 'could not score the run; it goes on unscored');
    return null;
  }
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
