import {
  TERMINAL_ISSUE_STATUSES,
  type BugClass,
  type IssueStatus,
  type Run,
  type Severity,
  type Tier,
} from '@page/contracts';
import { AGENT_BRANCH_PREFIX, type GitHub, type PullRequest } from '@page/toolkit';
import type { Scenario } from './scenario.ts';

// The end-to-end test of the live pipeline (#14). It seeds a scenario's bug on a target demo
// app, fires it with trigger.sh, then follows the error through the PostHog webhook, triage,
// the fix run, and the PR or approval request the run ends on, timing every step. Then it
// resets the target for the next run. Each outside system is a port, so the steps run on
// fakes in tests. The real adapters are in scripts/.

export const E2E_STEPS = [
  'seed',
  'trigger',
  'issue',
  'triage',
  'claim',
  'fix',
  'outcome',
  'assert',
  'reset',
] as const;
export type E2EStep = (typeof E2E_STEPS)[number];

/** Steps with a time limit. `assert` only reads state, so it has none. */
export type TimedStep = Exclude<E2EStep, 'assert'>;
export type Timeouts = Record<TimedStep, number>;

const MINUTE = 60_000;

/**
 * Per-step limits. A Tier 1 run's wall clock is 14 minutes (docs/report/eval-prereg.md),
 * and a ladder run climbs a tier at a time, so `fix` gets 16 minutes per tier up to the
 * scenario's expected tier. Seeding may build Docker images; the webhook waits on PostHog.
 */
export function defaultTimeouts(scenario: Scenario): Timeouts {
  return {
    seed: 20 * MINUTE,
    trigger: 2 * MINUTE,
    issue: 5 * MINUTE,
    triage: 2 * MINUTE,
    claim: 5 * MINUTE,
    fix: 16 * MINUTE * scenario.meta.expectedTier,
    outcome: 2 * MINUTE,
    reset: 10 * MINUTE,
  };
}

/** The step limits for `scenario`, with `overrides` (from `--timeout`) over the defaults. */
export function stepTimeouts(scenario: Scenario, overrides: Partial<Timeouts> = {}): Timeouts {
  return { ...defaultTimeouts(scenario), ...overrides };
}

/** The steps between the trigger and the outcome, which `--budget` covers. */
const BUDGET_STEPS = ['trigger', 'issue', 'triage', 'claim', 'fix', 'outcome'] as const;

/**
 * The default `--budget`: the sum of the limits of the steps it covers, so a run that
 * passes every step never fails on the budget alone. It grows with the scenario's tier
 * through `fix`: 32 minutes at Tier 1, 48 at Tier 2 and 64 at Tier 3 with the default
 * limits, and follows any `--timeout` given.
 */
export function defaultBudget(timeouts: Timeouts): number {
  return BUDGET_STEPS.reduce((sum, step) => sum + timeouts[step], 0);
}

/**
 * What the run should end on. `pr`: an open PR from `pageagents/<runId>` on the demo repo.
 * `approval`: the issue waits on a human, either with a patch (`awaiting_approval`) or with
 * a pending Tier 3 approval request on its run. `resolved`: a Tier 3 run fixed the live app
 * through the ops API and changed no code, so the orchestrator resolved the issue
 * (`ops_fixed`).
 */
export type Expectation = 'pr' | 'approval' | 'resolved';

/**
 * Tier 2 code fixes open a PR, and Tier 1 can't push, so its patch waits for approval. An ops
 * fix is live once Tier 3 makes it, so the issue resolves.
 */
export function defaultExpectation(scenario: Scenario): Expectation {
  if (scenario.kind === 'ops') return 'resolved';
  return scenario.meta.expectedTier === 2 ? 'pr' : 'approval';
}

// ---- Ports -----------------------------------------------------------------------------

/** The demo app the scenario runs against, and how to break, fire and fix it there. */
export interface Target {
  /** `local` or `staging`, for the report. */
  name: string;
  /** Plants the scenario's bug and waits until the app serves it. */
  seed(scenario: Scenario, signal: AbortSignal): Promise<void>;
  /** Runs trigger.sh against the app and resolves with what it printed. */
  trigger(scenario: Scenario, signal: AbortSignal): Promise<string>;
  /** Takes the bug back out, as far as `seed` got. */
  unseed(scenario: Scenario, signal: AbortSignal): Promise<void>;
  /**
   * Work done once before the first run, outside every step so the seed times of a batch
   * compare: the local target's image builds. Resolves with what it did, or null when
   * there was nothing to do.
   */
  prepare?(scenario: Scenario, signal: AbortSignal): Promise<string | null>;
  /**
   * The target's own logs after a failed seed, read before the reset takes the bug back
   * out: the tail of the local demo app container's. Null when there are none.
   */
  logs?(scenario: Scenario, signal: AbortSignal): Promise<string | null>;
}

/** An `issues` row, with the columns the API leaves out. */
export interface IssueRow {
  id: string;
  fingerprint: string;
  title: string;
  status: IssueStatus;
  class: BugClass | null;
  severity: Severity | null;
  currentTier: Tier | null;
  currentRunId: string | null;
  occurrences: number;
  createdAt: Date;
  lastSeenAt: Date;
  /** Whether an `ops_fixed` event resolved it: a Tier 3 run's fix, made live through ops. */
  opsFixed: boolean;
}

/** pg-boss job states (pg-boss `states`), as the `job` table's `state` column holds them. */
export const JOB_STATES = [
  'created',
  'retry',
  'active',
  'completed',
  'cancelled',
  'failed',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** A `runs` row. The orchestrator writes these once RunsModule lands (#8). */
export interface RunRow {
  id: string;
  tier: Tier;
  status: Run['status'];
  startedAt: Date | null;
  finishedAt: Date | null;
  prUrl: string | null;
}

/** What the database says about one fix run. */
export interface RunProgress {
  runId: string;
  /** Null until the orchestrator records the run. */
  run: RunRow | null;
  /** The fix job's state in pg-boss, or null once pg-boss has deleted it. */
  jobState: JobState | null;
  /** Rows in `steps`. The daemon writes one before every command. */
  steps: number;
  /** Pending rows in `approvals`. */
  pendingApprovals: number;
}

/** Reads the orchestrator's database. */
export interface PipelineReader {
  /** The database's clock, so issue times compare without skew from this machine's. */
  now(): Promise<Date>;
  /** Issues whose last occurrence is at or after `since`, newest first. */
  issuesSeenSince(since: Date): Promise<IssueRow[]>;
  issue(id: string): Promise<IssueRow | null>;
  run(runId: string): Promise<RunProgress>;
  /**
   * Every fix run the issue had, oldest first: the pg-boss `fix` jobs for it and its
   * `runs` rows, so the reset finds runs the test never saw.
   */
  runIdsForIssue(issueId: string): Promise<string[]>;
}

/** The orchestrator's write API, for the reset. */
export interface PipelineControl {
  /** Kills an open issue, which cancels its fix job. */
  killIssue(id: string): Promise<void>;
}

/** The demo repo: the PR lookup and, for the reset, closing it. */
export type GitHubReader = Pick<GitHub, 'findOpenPullRequest' | 'closePullRequest'>;

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** `--approve`: the harness approves its own runs' Tier 3 requests, or a person does. */
export type ApproveMode = 'auto' | 'manual';

/** One Tier 3 approval the harness made, as the result file keeps it. */
export interface E2EApproval {
  approvalId: string;
  runId: string;
  /** The gated tool, such as `ops.restart`. */
  action: string;
  /** When the harness sent its decision. */
  sentAt: string;
  /**
   * The decision that stands, once the orchestrator says: `approved` under the harness's
   * name, or what stood instead, such as `rejected` by `system:timed_out`. Null if it never
   * said.
   */
  decision: 'approved' | 'rejected' | null;
  decidedBy: string | null;
}

/**
 * Approves the Tier 3 requests of the test's own runs, as a person would on the incident
 * page (src/e2e-approvals.ts). Only with `--approve auto`.
 */
export interface RunApprover {
  /** Approves `runId`'s requests from now on, those already waiting included. */
  watch(runId: string): void;
  /** Stops approving, before the reset kills the issue. */
  release(): void;
  /** The approvals it made for `runIds`, in the order it made them. */
  approvals(runIds: readonly string[]): E2EApproval[];
}

export interface E2EDeps {
  target: Target;
  reader: PipelineReader;
  control: PipelineControl;
  /** Needed for `expect: 'pr'`. Without it the reset can't close PRs. */
  github?: GitHubReader;
  /** With `--approve auto`: approves each Tier 3 request of the runs the test follows. */
  approver?: RunApprover;
  clock: Clock;
  log?: (line: string) => void;
}

export interface E2EOptions {
  expect?: Expectation;
  /**
   * How the scenario's Tier 3 requests get decided, for the result: `auto` with an approver
   * in the deps, `manual` for a person on the page. Left out for a scenario that can't reach
   * Tier 3.
   */
  approve?: ApproveMode;
  timeouts?: Partial<Timeouts>;
  /** Between database reads while waiting (default 3 s). */
  pollMs?: number;
  /**
   * How long a fix job may sit finished while the issue is still `fixing` before the run
   * counts as lost: its result never reached the orchestrator (default 60 s).
   */
  settleMs?: number;
  /** Most time from the trigger to the PR or approval request (default `defaultBudget`). */
  budgetMs?: number;
  /** Skip the reset, to look at the PR or the issue afterwards. */
  keep?: boolean;
  /**
   * How long the reset watches a run a daemon is still on for a PR after the kill, closing
   * any that opens. Default: what is left of the run's share of the `fix` limit (16 minutes
   * per tier) since the test first saw it claimed. 0 skips the watch.
   */
  drainMs?: number;
}

// ---- Result ----------------------------------------------------------------------------

export interface StepRecord {
  step: E2EStep;
  /** Milliseconds from the start of the test. */
  offsetMs: number;
  durationMs: number;
  ok: boolean;
  detail: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  /** A failed `error` check fails the test; a failed `warn` is reported only. */
  level: 'error' | 'warn';
  detail: string;
}

export interface ResetAction {
  action: string;
  ok: boolean;
  detail: string;
}

export interface E2ERun {
  runId: string;
  tier: Tier | null;
}

export interface E2EResult {
  v: 1;
  scenario: string;
  target: string;
  expect: Expectation;
  startedAt: string;
  passed: boolean;
  /** The first step that failed, reset included. */
  failedStep: E2EStep | null;
  error: string | null;
  steps: StepRecord[];
  issueId: string | null;
  /** Every run the issue went through, in order. A ladder climb has one per tier. */
  runs: E2ERun[];
  prUrl: string | null;
  /** From the trigger to the PR or approval request. */
  timeToOutcomeMs: number | null;
  checks: CheckResult[];
  reset: ResetAction[];
  /** The target's logs when the seed failed, read before the reset (Target.logs). */
  seedLogs: string | null;
  /** How Tier 3 requests were decided (`--approve`), or null for a scenario without them. */
  approve: ApproveMode | null;
  /** Each Tier 3 approval the harness made, in order. Empty with `--approve manual`. */
  approvals: E2EApproval[];
}

/** The target's one-time preparation before the runs (Target.prepare). */
export interface SetupRecord {
  ok: boolean;
  durationMs: number;
  detail: string;
}

/** The `--out` file: the one-time preparation, if any, then every run. */
export interface E2EReport {
  v: 1;
  prepare: SetupRecord | null;
  runs: E2EResult[];
}

/** A step that failed or ran out of time. */
export class E2EFailure extends Error {
  override name = 'E2EFailure';
  readonly step: E2EStep;
  constructor(step: E2EStep, message: string) {
    super(message);
    this.step = step;
  }
}

// ---- Helpers ---------------------------------------------------------------------------

/** `125000` as `2m05s`, `4200` as `4.2s`. */
export function formatMs(ms: number): string {
  if (ms < MINUTE) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const UNITS = { ms: 1, s: 1000, m: MINUTE, h: 60 * MINUTE } as const;

/** `90s`, `20m`, `1.5h` or `500ms` in milliseconds. Throws on anything else. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text.trim());
  if (match === null) throw new Error(`${JSON.stringify(text)} is not a duration like 90s or 20m`);
  const ms = Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
  if (!(ms > 0)) throw new Error(`${JSON.stringify(text)} must be longer than 0`);
  return ms;
}

/** `--drain`: a duration, or `0` to skip the watch. */
export function parseDrain(text: string): number {
  return /^0+(?:\.0+)?(?:ms|s|m|h)?$/.test(text.trim()) ? 0 : parseDuration(text);
}

/** `--timeout` values, `fix=20m` each, as step limits. */
export function parseTimeouts(values: readonly string[]): Partial<Timeouts> {
  const steps: readonly string[] = E2E_STEPS.filter((s) => s !== 'assert');
  const timeouts: Partial<Timeouts> = {};
  for (const value of values) {
    const [name, duration, ...rest] = value.split('=');
    if (name === undefined || duration === undefined || rest.length > 0 || !steps.includes(name)) {
      throw new Error(
        `${JSON.stringify(value)}: want <step>=<duration>, step one of ${steps.join(', ')}`,
      );
    }
    timeouts[name as TimedStep] = parseDuration(duration);
  }
  return timeouts;
}

/** The result as a few lines for the terminal. */
export function summarize(r: E2EResult): string {
  const lines = [
    `${r.passed ? 'PASS' : 'FAIL'} ${r.scenario} on ${r.target} (expect ${r.expect})` +
      (r.error === null ? '' : `: ${r.failedStep} ${r.error}`),
  ];
  for (const s of r.steps) {
    const mark = s.ok ? 'ok  ' : 'FAIL';
    lines.push(`  ${mark} ${s.step.padEnd(8)} ${formatMs(s.durationMs).padStart(7)}  ${s.detail}`);
  }
  if (r.timeToOutcomeMs !== null) {
    lines.push(`  trigger to outcome: ${formatMs(r.timeToOutcomeMs)}`);
  }
  for (const c of r.checks.filter((c) => !c.ok)) {
    lines.push(`  ${c.level} ${c.name}: ${c.detail}`);
  }
  for (const a of r.approvals) {
    const outcome = a.decision === null ? 'no answer' : `${a.decision} by ${a.decidedBy}`;
    lines.push(`  approved ${a.action} on run ${a.runId}: ${outcome}`);
  }
  for (const a of r.reset.filter((a) => !a.ok)) {
    lines.push(`  reset ${a.action} failed: ${a.detail}`);
  }
  if (r.seedLogs !== null) {
    lines.push(`  ${r.target} logs:`, ...r.seedLogs.split('\n').map((line) => `    ${line}`));
  }
  return lines.join('\n');
}

/** The error line of a scenario's report: the first line after the request line. */
export function reportErrorLine(report: string): string | null {
  const lines = report.split('\n');
  const blank = lines.findIndex((line) => line.trim() === '');
  if (blank === -1) return null;
  return lines.slice(blank + 1).find((line) => line.trim() !== '') ?? null;
}

/**
 * Whether an issue's title is the report's error line. The orchestrator titles an issue
 * with the whole exception, `<type>: <message>` cut at 500 characters (ingest titleFrom),
 * so a multi-line message such as a ZodError's JSON only matches on its first line.
 */
export function issueTitleMatches(title: string, errorLine: string): boolean {
  return firstLine(title) === errorLine.trim();
}

const firstLine = (text: string) => (text.split('\n')[0] ?? '').trim();

const isTerminal = (status: IssueStatus) =>
  (TERMINAL_ISSUE_STATUSES as readonly IssueStatus[]).includes(status);
const JOB_DONE: readonly JobState[] = ['completed', 'failed', 'cancelled'];
const RUN_DONE: readonly Run['status'][] = ['succeeded', 'escalated', 'failed', 'killed'];

const agentBranch = (runId: string) => `${AGENT_BRANCH_PREFIX}${runId}`;

function describeIssue(issue: IssueRow | null): string {
  if (issue === null) return 'issue row gone';
  const run = issue.currentRunId === null ? 'no run' : `run ${issue.currentRunId}`;
  return `issue ${issue.status} at tier ${issue.currentTier ?? '-'}, ${run}`;
}

function describeProgress(p: RunProgress): string {
  const row = p.run === null ? 'no runs row' : `runs row ${p.run.status}`;
  return `job ${p.jobState ?? 'gone'}, ${row}, ${p.steps} steps, ${p.pendingApprovals} pending approvals`;
}

function runFinished(p: RunProgress): boolean {
  return (
    (p.jobState !== null && JOB_DONE.includes(p.jobState)) ||
    (p.run !== null && RUN_DONE.includes(p.run.status))
  );
}

function runClaimed(p: RunProgress): boolean {
  return (
    p.jobState === 'active' ||
    runFinished(p) ||
    p.steps > 0 ||
    (p.run !== null && p.run.startedAt !== null)
  );
}

/**
 * Runs `work` with a time limit on `clock`. Past it, `work`'s signal aborts and this
 * rejects with an E2EFailure for `step`.
 */
async function withTimeout<T>(
  clock: Clock,
  step: E2EStep,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stop = new AbortController();
  const settled = new AbortController();
  const running = work(stop.signal);
  // Once the timeout won, whatever `work` does after its signal aborted is moot.
  running.catch(() => {});
  const timeout = clock.sleep(ms, settled.signal).then(
    () => {
      const failure = new E2EFailure(step, `timed out after ${formatMs(ms)}`);
      stop.abort(failure);
      throw failure;
    },
    // The work settled first and cancelled the timer.
    () => new Promise<never>(() => {}),
  );
  try {
    return await Promise.race([running, timeout]);
  } finally {
    settled.abort();
  }
}

// After this many reads in a row throw, the wait stops instead of polling a dead database.
const MAX_READ_ERRORS = 5;

/**
 * Calls `probe` every `pollMs` until it returns a value, and fails with `describe()` (the
 * last state seen) once `ms` is up. A probe can throw E2EFailure to stop at once.
 */
async function waitFor<T>(
  clock: Clock,
  step: E2EStep,
  ms: number,
  pollMs: number,
  probe: () => Promise<T | undefined>,
  describe: () => string,
): Promise<T> {
  const deadline = clock.now() + ms;
  let errors = 0;
  let lastError = '';
  for (;;) {
    try {
      const value = await probe();
      errors = 0;
      if (value !== undefined) return value;
    } catch (error) {
      if (error instanceof E2EFailure) throw error;
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
      if (errors >= MAX_READ_ERRORS) {
        throw new E2EFailure(step, `${errors} reads failed in a row: ${lastError}`);
      }
    }
    const left = deadline - clock.now();
    if (left <= 0) {
      const last = lastError === '' ? '' : ` (last read error: ${lastError})`;
      throw new E2EFailure(step, `timed out after ${formatMs(ms)}: ${describe()}${last}`);
    }
    await clock.sleep(Math.min(pollMs, left));
  }
}

// A target's logs are a few lines from a local command; past this, the reset goes ahead.
const LOGS_MS = 30_000;

/** Target.logs, bounded, with a note in place of the logs when they couldn't be read. */
async function targetLogs(
  scenario: Scenario,
  target: Target,
  clock: Clock,
): Promise<string | null> {
  if (target.logs === undefined) return null;
  const logs = target.logs.bind(target);
  try {
    return await withTimeout(clock, 'seed', LOGS_MS, (signal) => logs(scenario, signal));
  } catch (error) {
    return `(could not read them: ${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Runs the target's one-time preparation (Target.prepare), such as building images, under
 * `timeoutMs`. Null when the target has none or there was nothing to do.
 */
export async function prepareTarget(
  scenario: Scenario,
  target: Target,
  {
    clock,
    timeoutMs,
    log = () => {},
  }: { clock: Clock; timeoutMs: number; log?: (line: string) => void },
): Promise<SetupRecord | null> {
  if (target.prepare === undefined) return null;
  const prepare = target.prepare.bind(target);
  const began = clock.now();
  log('[prepare] ...');
  try {
    const detail = await withTimeout(clock, 'seed', timeoutMs, (signal) =>
      prepare(scenario, signal),
    );
    const durationMs = clock.now() - began;
    if (detail === null) {
      log('[prepare] nothing to do');
      return null;
    }
    log(`[prepare] ok in ${formatMs(durationMs)}: ${detail}`);
    return { ok: true, durationMs, detail };
  } catch (error) {
    const durationMs = clock.now() - began;
    const detail = error instanceof Error ? error.message : String(error);
    log(`[prepare] FAILED after ${formatMs(durationMs)}: ${detail}`);
    return { ok: false, durationMs, detail };
  }
}

// ---- The test --------------------------------------------------------------------------

/**
 * Plays one scenario end to end and resets the target. Resolves for every outcome; a
 * failed step is in `failedStep` and `error`, with the steps before it timed.
 */
export async function runE2E(
  scenario: Scenario,
  deps: E2EDeps,
  options: E2EOptions = {},
): Promise<E2EResult> {
  const { target, reader, github, clock } = deps;
  const log = deps.log ?? (() => {});
  const expect = options.expect ?? defaultExpectation(scenario);
  const timeouts = stepTimeouts(scenario, options.timeouts);
  const pollMs = options.pollMs ?? 3000;
  const settleMs = options.settleMs ?? MINUTE;
  const budgetMs = options.budgetMs ?? defaultBudget(timeouts);
  const start = clock.now();

  const result: E2EResult = {
    v: 1,
    scenario: scenario.id,
    target: target.name,
    expect,
    startedAt: new Date(start).toISOString(),
    passed: false,
    failedStep: null,
    error: null,
    steps: [],
    issueId: null,
    runs: [],
    prUrl: null,
    timeToOutcomeMs: null,
    checks: [],
    reset: [],
    seedLogs: null,
    approve: options.approve ?? null,
    approvals: [],
  };
  const { approver } = deps;

  /** Runs one step, records its time, and passes its detail on to the log. */
  async function step<T>(
    name: E2EStep,
    work: () => Promise<{ value: T; detail: string }>,
  ): Promise<T> {
    const began = clock.now();
    log(`[${name}] ...`);
    try {
      const { value, detail } = await work();
      const durationMs = clock.now() - began;
      result.steps.push({ step: name, offsetMs: began - start, durationMs, ok: true, detail });
      log(`[${name}] ok in ${formatMs(durationMs)}${detail === '' ? '' : `: ${detail}`}`);
      return value;
    } catch (error) {
      // Whatever threw, the failure belongs to the step that was running.
      const failure = new E2EFailure(name, error instanceof Error ? error.message : String(error));
      const durationMs = clock.now() - began;
      result.steps.push({
        step: name,
        offsetMs: began - start,
        durationMs,
        ok: false,
        detail: failure.message,
      });
      log(`[${name}] FAILED after ${formatMs(durationMs)}: ${failure.message}`);
      throw failure;
    }
  }

  // Checked before seeding, so a run that can't pass doesn't touch the target, and the
  // reset has nothing to undo.
  const title = reportErrorLine(scenario.meta.report);
  const unplayable =
    title === null
      ? `${scenario.id}'s report has no error line to match the issue's title against`
      : expect === 'pr' && github === undefined
        ? 'expecting a PR, but no GitHub reader was given'
        : null;
  if (title === null || unplayable !== null) {
    result.failedStep = 'seed';
    result.error = unplayable;
    log(`[seed] not started: ${unplayable}`);
    return result;
  }

  // Every run the test read, for the reset: which ones a daemon may still be on.
  const watched: Watched = new Map();
  const observe = (p: RunProgress): RunProgress => {
    const claimedAt = watched.get(p.runId)?.claimedAt ?? (runClaimed(p) ? clock.now() : null);
    watched.set(p.runId, { claimedAt, progress: p });
    return p;
  };
  // The database's clock when the trigger ran: an issue it opened was created after it.
  let triggeredSince: Date | null = null;

  let issue: IssueRow | null = null;
  try {
    await step('seed', async () => {
      try {
        await withTimeout(clock, 'seed', timeouts.seed, (signal) => target.seed(scenario, signal));
      } catch (error) {
        // Now, while the target still has them: the reset's unseed may remove them.
        result.seedLogs = await targetLogs(scenario, target, clock);
        throw error;
      }
      return { value: undefined, detail: `${scenario.id} on ${target.name}` };
    });

    const triggeredAt = clock.now();
    const since = await step('trigger', async () => {
      const at = await reader.now();
      triggeredSince = at;
      const output = await withTimeout(clock, 'trigger', timeouts.trigger, (signal) =>
        target.trigger(scenario, signal),
      );
      return { value: at, detail: output.trim().split('\n').slice(-3).join(' | ') };
    });

    // Only an issue titled like the report counts. Another one seen meanwhile is some
    // other error, so the wait goes on until the step's limit.
    let seen: IssueRow[] = [];
    issue = await step('issue', async () => {
      const found = await waitFor(
        clock,
        'issue',
        timeouts.issue,
        pollMs,
        async () => {
          seen = await reader.issuesSeenSince(since);
          const pick = seen.find((i) => issueTitleMatches(i.title, title));
          if (pick !== undefined && pick.createdAt < since) {
            throw new E2EFailure(
              'issue',
              `issue ${pick.id} was already open (${pick.status}) since ` +
                `${pick.createdAt.toISOString()}, so the trigger only counted another ` +
                'occurrence and nothing new will be triaged. Kill it and run again.',
            );
          }
          return pick;
        },
        () =>
          seen.length === 0
            ? 'no issue opened since the trigger (is the PostHog webhook pointed at this orchestrator?)'
            : `${seen.length} issues seen since the trigger, none titled ${JSON.stringify(title)}: ` +
              seen.map((i) => JSON.stringify(firstLine(i.title))).join(', '),
      );
      result.issueId = found.id;
      return { value: found, detail: `${found.id} ${JSON.stringify(firstLine(found.title))}` };
    });
    const issueId = issue.id;

    const read = async (): Promise<IssueRow> => {
      const row = await reader.issue(issueId);
      if (row === null) throw new E2EFailure('fix', `issue ${issueId} is gone`);
      issue = row;
      return row;
    };

    await step('triage', async () => {
      const triaged = await waitFor(
        clock,
        'triage',
        timeouts.triage,
        pollMs,
        async () => {
          const row = await read();
          return row.status === 'new' ? undefined : row;
        },
        () => describeIssue(issue),
      );
      return { value: undefined, detail: `${triaged.class}/${triaged.severity}` };
    });

    // The run the issue is on now, as first seen; a ladder climb adds one per tier.
    const track = (row: IssueRow): E2ERun | undefined => {
      if (row.currentRunId === null) return undefined;
      const last = result.runs.at(-1);
      if (last?.runId === row.currentRunId) return last;
      const run = { runId: row.currentRunId, tier: row.currentTier };
      result.runs.push(run);
      log(`[fix] run ${run.runId} at tier ${run.tier ?? '-'}`);
      approver?.watch(run.runId);
      return run;
    };
    // Runs already told that a person has to approve on the page (`--approve manual`).
    const toldToApprove = new Set<string>();
    // `resolved` too, unless `ops_fixed` got it there: otherwise only a human's approve does
    // (issues/transitions.ts), so the test can no longer see the outcome it waits for, nor
    // tell a PR from a patch. An ops fix is an outcome, which `outcome` checks.
    const stopIfEnded = (row: IssueRow, at: E2EStep) => {
      if (row.opsFixed) return;
      if (row.status === 'resolved') {
        throw new E2EFailure(
          at,
          `issue was resolved at tier ${row.currentTier ?? '-'}: someone approved it before ` +
            'the test saw its outcome',
        );
      }
      if (isTerminal(row.status)) {
        throw new E2EFailure(at, `issue ended ${row.status} at tier ${row.currentTier ?? '-'}`);
      }
    };

    let progress: RunProgress | null = null;
    await step('claim', async () => {
      const claimed = await waitFor(
        clock,
        'claim',
        timeouts.claim,
        pollMs,
        async () => {
          const row = await read();
          stopIfEnded(row, 'claim');
          const run = track(row);
          if (run === undefined) return undefined;
          progress = observe(await reader.run(run.runId));
          return runClaimed(progress) ? run : undefined;
        },
        () => {
          const hint = issue?.status === 'triaged' ? ' (nothing sent start_fix after triage)' : '';
          return `${describeIssue(issue)}${hint}${progress === null ? '' : `, ${describeProgress(progress)}`}`;
        },
      );
      return { value: undefined, detail: `run ${claimed.runId} at tier ${claimed.tier ?? '-'}` };
    });

    // Done when the issue waits on a human (a patch or PR), a Tier 3 ops fix resolved it, or
    // with `--expect approval` a Tier 3 run asks for approval. Otherwise a pending request is
    // part of the fix: the approver grants it, or a person does on the page.
    let finishedAt: number | null = null;
    let finishedRun = '';
    await step('fix', async () => {
      const done = await waitFor(
        clock,
        'fix',
        timeouts.fix,
        pollMs,
        async () => {
          const row = await read();
          stopIfEnded(row, 'fix');
          const run = track(row);
          if (row.status === 'awaiting_approval' || row.status === 'pr_open' || row.opsFixed) {
            return row;
          }
          if (run === undefined) return undefined;
          progress = observe(await reader.run(run.runId));
          if (progress.pendingApprovals > 0) {
            if (expect === 'approval') return row;
            if (approver === undefined && !toldToApprove.has(run.runId)) {
              toldToApprove.add(run.runId);
              log(
                `[fix] run ${run.runId} is waiting for approval: approve or reject it on the ` +
                  `incident page for issue ${issueId}`,
              );
            }
            return undefined;
          }
          if (!runFinished(progress)) return undefined;
          // The run is over; the orchestrator should move the issue on any moment.
          if (finishedRun !== run.runId) {
            finishedRun = run.runId;
            finishedAt = clock.now();
          } else if (finishedAt !== null && clock.now() - finishedAt >= settleMs) {
            throw new E2EFailure(
              'fix',
              `run ${run.runId} finished (${describeProgress(progress)}) but the issue is ` +
                `still ${row.status} after ${formatMs(settleMs)}: its result never reached ` +
                'the orchestrator',
            );
          }
          return undefined;
        },
        () =>
          `${describeIssue(issue)}${progress === null ? '' : `, ${describeProgress(progress)}`}`,
      );
      const tiers = result.runs.map((r) => r.tier ?? '-').join(' -> ');
      return { value: undefined, detail: `issue ${done.status}, tiers ${tiers}` };
    });

    const finalRun = result.runs.at(-1)!;
    let pr: PullRequest | null = null;
    await step('outcome', async () => {
      const detail = await waitFor(
        clock,
        'outcome',
        timeouts.outcome,
        pollMs,
        async () => {
          const row = await read();
          stopIfEnded(row, 'outcome');
          // A patch only ends `awaiting_approval` through patch_ready (issues/transitions.ts),
          // and Tier 1 can't push, so its patch never comes with a PR.
          if (expect === 'pr' && row.status === 'awaiting_approval' && row.currentTier === 1) {
            throw new E2EFailure(
              'outcome',
              "tier 1 ended on a patch awaiting approval; Tier 1 can't push, so no PR can open",
            );
          }
          const tier = row.currentTier ?? '-';
          if (row.opsFixed && expect !== 'resolved') {
            throw new E2EFailure(
              'outcome',
              `tier ${tier} fixed the live app through the ops API and the issue resolved; ` +
                'pass --expect resolved for it',
            );
          }
          if (
            expect === 'resolved' &&
            (row.status === 'awaiting_approval' || row.status === 'pr_open')
          ) {
            throw new E2EFailure(
              'outcome',
              `tier ${tier} left a patch for review, not a fix made live through the ops API`,
            );
          }
          progress = observe(await reader.run(finalRun.runId));
          if (expect === 'resolved') {
            return row.opsFixed ? 'issue resolved by an ops fix' : undefined;
          }
          if (expect === 'pr') {
            pr = await github!.findOpenPullRequest(agentBranch(finalRun.runId));
            if (pr === null) return undefined;
            result.prUrl = pr.url;
            return `PR #${pr.number} ${pr.url}`;
          }
          if (progress.pendingApprovals > 0) return `${progress.pendingApprovals} pending approval`;
          if (row.status === 'awaiting_approval') return 'issue awaiting_approval';
          return undefined;
        },
        () =>
          expect === 'pr'
            ? `no open PR from ${agentBranch(finalRun.runId)}; ${describeIssue(issue)}`
            : `${describeIssue(issue)}${progress === null ? '' : `, ${describeProgress(progress)}`}`,
      );
      result.timeToOutcomeMs = clock.now() - triggeredAt;
      return { value: undefined, detail };
    });

    await step('assert', async () => {
      const row = await read();
      const final = observe(await reader.run(finalRun.runId));
      result.checks = assertEndState(scenario, expect, row, final, finalRun, pr, {
        timeToOutcomeMs: result.timeToOutcomeMs!,
        budgetMs,
      });
      const failed = result.checks.filter((c) => !c.ok && c.level === 'error');
      for (const c of result.checks.filter((c) => !c.ok)) {
        log(`[assert] ${c.level} ${c.name}: ${c.detail}`);
      }
      if (failed.length > 0) {
        throw new E2EFailure('assert', `failed: ${failed.map((c) => c.name).join(', ')}`);
      }
      const warned = result.checks.filter((c) => !c.ok).length;
      return { value: undefined, detail: `${result.checks.length} checks, ${warned} warnings` };
    });
  } catch (error) {
    const failure = error instanceof E2EFailure ? error : new E2EFailure('seed', String(error));
    result.failedStep = failure.step;
    result.error = failure.message;
  }

  // Nothing is approved from here on: the reset kills the issue, and a call approved after
  // that could still change the app.
  approver?.release();

  if (options.keep) {
    result.steps.push({
      step: 'reset',
      offsetMs: clock.now() - start,
      durationMs: 0,
      ok: true,
      detail: 'skipped (keep)',
    });
    log('[reset] skipped: keep');
  } else {
    // A run's share of the fix limit: a ladder climb gets `fix` over its expected tiers.
    const runFixMs = timeouts.fix / scenario.meta.expectedTier;
    const drainLimit = options.drainMs ?? runFixMs;
    try {
      await step('reset', async () => {
        // The drain may watch for up to its window on top of the reset's own work.
        await withTimeout(clock, 'reset', timeouts.reset + drainLimit, (signal) =>
          reset({
            scenario,
            deps,
            result,
            signal,
            watched,
            observe,
            late: triggeredSince === null ? null : { since: triggeredSince, title },
            pollMs,
            runFixMs,
            drainMs: options.drainMs,
          }),
        );
        const failed = result.reset.filter((a) => !a.ok);
        if (failed.length > 0) {
          throw new E2EFailure('reset', failed.map((a) => `${a.action}: ${a.detail}`).join('; '));
        }
        return { value: undefined, detail: result.reset.map((a) => a.action).join(', ') };
      });
    } catch (error) {
      if (result.failedStep === null) {
        result.failedStep = 'reset';
        result.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  result.approvals = approver?.approvals(result.runs.map((r) => r.runId)) ?? [];
  result.passed = result.failedStep === null;
  return result;
}

/** What the test last read about each run, and when it first saw a daemon on it. */
type Watched = Map<string, { claimedAt: number | null; progress: RunProgress }>;

interface ResetContext {
  scenario: Scenario;
  deps: E2EDeps;
  result: E2EResult;
  signal: AbortSignal;
  watched: Watched;
  /** Records a run read, as the steps do. */
  observe: (p: RunProgress) => RunProgress;
  /** For an issue the trigger opened after the `issue` step gave up. Null if it never ran. */
  late: { since: Date; title: string } | null;
  pollMs: number;
  /** A run's share of the `fix` limit, for its default drain window. */
  runFixMs: number;
  drainMs: number | undefined;
}

type Attempt = (action: string, work: () => Promise<string>) => Promise<void>;

/** A run a daemon was still on when the reset began, first seen claimed at `claimedAt`. */
interface InFlightRun {
  runId: string;
  claimedAt: number;
}

/** One run's branch the drain watches until `until`, and what it last saw there. */
interface DrainWatch {
  runId: string;
  until: number;
  /** The PR last seen open and not closed yet. */
  open: PullRequest | null;
  /** The last lookup or close error, cleared by a lookup that works. */
  error: string | null;
  /** The detail once its PR is closed. */
  closed: string | null;
}

// The drain polls GitHub, not the database: a PR closed ten seconds late is as good.
const DRAIN_POLL_MS = 10_000;

const closeComment = (scenario: Scenario, runId: string) =>
  `Closed by the end-to-end test reset: run \`${runId}\` was a test run of \`${scenario.id}\`.`;

/**
 * Puts things back for the next run, each part on its own so one failure doesn't skip
 * the rest: kills the issue so the next trigger opens a new one, closes the PRs of all
 * its runs, watches the runs still in flight for a late PR, and takes the bug off the
 * target.
 */
async function reset(ctx: ResetContext): Promise<void> {
  const { scenario, result, signal, late } = ctx;
  const { target, reader, control, github } = ctx.deps;
  const attempt: Attempt = async (action, work) => {
    try {
      result.reset.push({ action, ok: true, detail: await work() });
    } catch (error) {
      result.reset.push({
        action,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let issueId = result.issueId;
  if (issueId === null && late !== null) {
    // The trigger ran, but the test never picked up its issue: the `issue` step ran out
    // first, or trigger.sh failed after its request went out. An issue opened since then
    // is the test's, and left open it fails the next run as already open.
    await attempt('look for a late issue', async () => {
      const seen = await reader.issuesSeenSince(late.since);
      const found = seen.find(
        (i) => issueTitleMatches(i.title, late.title) && i.createdAt >= late.since,
      );
      if (found === undefined) return 'none';
      issueId = found.id;
      return `${found.id} ${found.status}, opened ${found.createdAt.toISOString()}`;
    });
  }

  if (issueId !== null) {
    const id = issueId;
    // Read before the kill, which cancels the runs' jobs: after it, every run reads finished.
    const inFlight = await runsInFlight(ctx, id);

    // First, so no queued run starts after the closes below. A run a daemon has already
    // claimed goes on: the daemon only stops on a `kill` the gateway relays, and the
    // gateway is a stub. The drain after the closes watches those runs.
    await attempt(`kill issue ${id}`, async () => {
      const row = await reader.issue(id);
      if (row === null) return 'gone';
      if (isTerminal(row.status)) return `already ${row.status}`;
      await control.killIssue(id);
      return `was ${row.status}`;
    });

    if (github !== undefined) {
      // Every run of the issue, not only those the test saw: a run can start and give way
      // to the next tier between two reads. If the lookup fails, the seen ones still close.
      let runIds = result.runs.map((r) => r.runId);
      await attempt(`find the runs of issue ${id}`, async () => {
        const found = await reader.runIdsForIssue(id);
        runIds = [...new Set([...found, ...runIds])];
        return `${runIds.length} runs`;
      });
      for (const runId of runIds) {
        await attempt(`close PR of ${runId}`, async () => {
          const pr = await github.findOpenPullRequest(agentBranch(runId), signal);
          if (pr === null) return 'none open';
          await github.closePullRequest(pr.number, closeComment(scenario, runId), signal);
          return `closed #${pr.number}`;
        });
      }
    }

    await drain(ctx, inFlight, attempt);
  }

  await attempt('unseed', async () => {
    await target.unseed(scenario, signal);
    return target.name;
  });
}

/**
 * The issue's runs a daemon is still on: claimed and not finished. Each run the test knows
 * is read again, and so is the issue's current run, which it may never have seen; a failed
 * read keeps the last one. A run waiting on a pending approval is left out: nothing grants
 * it once the issue is killed, so it can't go on to open a PR.
 */
async function runsInFlight(ctx: ResetContext, issueId: string): Promise<InFlightRun[]> {
  const { reader } = ctx.deps;
  const ids = new Set([...ctx.watched.keys(), ...ctx.result.runs.map((r) => r.runId)]);
  try {
    const row = await reader.issue(issueId);
    if (row?.currentRunId) ids.add(row.currentRunId);
  } catch {
    // The kill below reports a database that can't be read.
  }
  for (const runId of ids) {
    try {
      ctx.observe(await reader.run(runId));
    } catch {
      // Keep the last read.
    }
  }
  return [...ctx.watched]
    .filter(
      ([, w]) =>
        w.claimedAt !== null && !runFinished(w.progress) && w.progress.pendingApprovals === 0,
    )
    .map(([runId, w]) => ({ runId, claimedAt: w.claimedAt! }));
}

/**
 * Watches each in-flight run's branch for a PR, closing any that opens, until the run's
 * window is up: `drainMs`, or what is left of its share of the `fix` limit. One action per
 * run watched; it fails when a PR is still open at the end.
 */
async function drain(ctx: ResetContext, inFlight: InFlightRun[], attempt: Attempt) {
  if (inFlight.length === 0) return;
  const { clock, github } = ctx.deps;
  const log = ctx.deps.log ?? (() => {});
  const start = clock.now();
  const watches = inFlight.map((r): DrainWatch => ({
    runId: r.runId,
    until: start + (ctx.drainMs ?? Math.max(0, r.claimedAt + ctx.runFixMs - start)),
    open: null,
    error: null,
    closed: null,
  }));

  const longest = Math.max(...watches.map((w) => w.until)) - start;
  const plan =
    github === undefined
      ? 'With no GitHub reader, the reset cannot close a PR it opens.'
      : longest === 0
        ? 'Not watching for a PR: --drain 0, or its share of the fix limit is up.'
        : `Watching for a PR for up to ${formatMs(longest)} (--drain to change), closing any that opens.`;
  log(
    `[reset] WARNING: ${inFlight.length === 1 ? 'run' : 'runs'} ` +
      `${inFlight.map((r) => r.runId).join(', ')} still in flight. The orchestrator can't ` +
      'stop a run a daemon has claimed yet (the kill cancels the job, but the gateway that ' +
      `would tell the daemon is a stub), so it may still open a PR. ${plan}`,
  );
  if (github === undefined) return;

  const timed = watches.filter((w) => w.until > start);
  const every = Math.max(ctx.pollMs, DRAIN_POLL_MS);
  let left = timed;
  while (left.length > 0) {
    for (const w of left) {
      try {
        w.open = await github.findOpenPullRequest(agentBranch(w.runId), ctx.signal);
        w.error = null;
        if (w.open !== null) {
          const pr = w.open;
          await github.closePullRequest(pr.number, closeComment(ctx.scenario, w.runId), ctx.signal);
          w.open = null;
          w.closed = `closed #${pr.number}, ${formatMs(clock.now() - start)} into the drain`;
        }
      } catch (error) {
        w.error = error instanceof Error ? error.message : String(error);
      }
    }
    // A run opens one PR at most, so a run whose PR closed is done.
    left = left.filter((w) => w.closed === null && clock.now() < w.until);
    if (left.length === 0) break;
    const next = Math.min(...left.map((w) => w.until)) - clock.now();
    await clock.sleep(Math.min(every, next), ctx.signal);
  }

  for (const w of timed) {
    await attempt(`drain PRs of ${w.runId}`, () => {
      if (w.closed !== null) return Promise.resolve(w.closed);
      const why = w.error === null ? '' : `: ${w.error}`;
      if (w.open !== null) {
        return Promise.reject(new Error(`PR #${w.open.number} still open after the drain${why}`));
      }
      if (w.error !== null) {
        return Promise.reject(new Error(`could not look for a PR at the end of the drain${why}`));
      }
      return Promise.resolve(`none opened in ${formatMs(w.until - start)}`);
    });
  }
}

/** The end state checks, once the run reached its outcome. */
export function assertEndState(
  scenario: Scenario,
  expect: Expectation,
  issue: IssueRow,
  progress: RunProgress,
  finalRun: E2ERun,
  pr: PullRequest | null,
  timing: { timeToOutcomeMs: number; budgetMs: number },
): CheckResult[] {
  const checks: CheckResult[] = [];
  const check = (name: string, level: CheckResult['level'], ok: boolean, detail: string) =>
    checks.push({ name, level, ok, detail });

  const waitingOnApproval = issue.status === 'fixing' && progress.pendingApprovals > 0;
  if (expect === 'resolved') {
    check(
      'issue.status',
      'error',
      issue.opsFixed,
      `${issue.status}${issue.opsFixed ? ' by ops_fixed' : ''}, want resolved by ops_fixed`,
    );
  } else {
    const statuses: readonly IssueStatus[] =
      expect === 'pr' ? ['pr_open', 'awaiting_approval'] : ['awaiting_approval'];
    check(
      'issue.status',
      'error',
      statuses.includes(issue.status) || (expect === 'approval' && waitingOnApproval),
      `${issue.status}, want ${statuses.join(' or ')}${expect === 'approval' ? ' or fixing with a pending approval' : ''}`,
    );
  }
  check(
    'issue.triaged',
    'error',
    issue.class !== null && issue.severity !== null,
    `class ${issue.class ?? 'null'}, severity ${issue.severity ?? 'null'}`,
  );
  check(
    'issue.class',
    'warn',
    issue.class === scenario.meta.class,
    `${issue.class ?? 'null'}, scenario says ${scenario.meta.class}`,
  );
  check(
    'run.current',
    'error',
    issue.currentRunId === finalRun.runId,
    `issue on ${issue.currentRunId ?? 'no run'}, test followed ${finalRun.runId}`,
  );
  check(
    'run.tier',
    'warn',
    issue.currentTier === scenario.meta.expectedTier,
    `tier ${issue.currentTier ?? '-'}, scenario expects ${scenario.meta.expectedTier}`,
  );
  check('run.steps', 'error', progress.steps > 0, `${progress.steps} steps recorded`);
  // Resolving the issue cancels the fix job of the run that fixed it, which can land before
  // the daemon marks that job complete.
  check(
    'run.job',
    'error',
    progress.jobState !== 'failed' && (progress.jobState !== 'cancelled' || issue.opsFixed),
    `fix job ${progress.jobState ?? 'gone'}`,
  );
  if (progress.run === null) {
    // The orchestrator writes the row from the run's run_finished job, so a run still
    // waiting on an approval has none yet.
    check('run.row', 'warn', false, 'no runs row (the run has not reported how it ended)');
  } else {
    const ok = waitingOnApproval
      ? progress.run.status === 'running'
      : progress.run.status === 'succeeded';
    check('run.row', 'error', ok, `runs row ${progress.run.status}`);
  }
  if (expect === 'pr') {
    const recorded = progress.run?.prUrl ?? null;
    check(
      'pr.recorded',
      'error',
      pr !== null && (recorded === null || recorded === pr.url),
      `PR ${pr?.url ?? 'none'}, runs row says ${recorded ?? 'nothing'}`,
    );
  }
  check(
    'time.outcome',
    'error',
    timing.timeToOutcomeMs <= timing.budgetMs,
    `${formatMs(timing.timeToOutcomeMs)} from trigger, budget ${formatMs(timing.budgetMs)}`,
  );
  return checks;
}
