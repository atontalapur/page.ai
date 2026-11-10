// Summarizes dev results per tier so the escalation threshold (#114) can be tuned: how
// attempts ended, what fixes used, and how many fixes a lower limit would have cut.
// Dev bugs only: the preregistration (docs/report/eval-prereg.md) keeps the held-out
// results unread until the threshold is frozen.
import { ESCALATION_THRESHOLD, type TierBudget } from '@page/agent';
import type { Tier } from '@page/contracts';
import { incomplete, percentile, percentileSec, ReportError, sec, table, usd } from './report.ts';
import type { Attempt, EvalResults } from './results.ts';

/** A loaded results file and the path it came from. */
export interface TuneFile {
  path: string;
  results: EvalResults;
}

/** A results file names a scenario outside the dev set. */
export class NotDevError extends ReportError {
  readonly file: string;
  readonly scenario: string;

  constructor(file: string, scenario: string, field: string) {
    super(`${file}: ${scenario} (in ${field}) is not a dev scenario; tune reads dev results only`);
    this.name = 'NotDevError';
    this.file = file;
    this.scenario = scenario;
  }
}

/** Throws NotDevError for the first scenario, in any list of any file, outside `dev`. */
export function assertDevOnly(files: readonly TuneFile[], dev: Iterable<string>): void {
  const devIds = new Set(dev);
  for (const { path, results } of files) {
    const lists = {
      runs: results.runs,
      errors: results.errors,
      notPlayed: results.notPlayed,
      skipped: results.skipped,
    };
    for (const [field, entries] of Object.entries(lists)) {
      const bad = entries.find((e) => !devIds.has(e.scenario));
      if (bad) throw new NotDevError(path, bad.scenario, field);
    }
  }
}

/** Candidate limits for the what-if tables. Only those at or below the current one show. */
export const CANDIDATES = {
  stepLimit: [10, 15, 20, 25, 30, 35, 40],
  costLimitUsd: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5],
  wallTimeLimitMs: [5, 8, 10, 12, 14].map((min) => min * 60 * 1000),
} as const satisfies Record<keyof TierBudget, readonly number[]>;

const TIERS = [1, 2, 3] as const satisfies readonly Tier[];

const LIMIT_EXITS = ['step_limit', 'cost_limit', 'time_limit'] as const;

const isLimitHit = (a: Attempt) => (LIMIT_EXITS as readonly string[]).includes(a.exitStatus);

/** Submitted, and the patch passed check.sh. */
export const isFix = (a: Attempt) => a.exitStatus === 'submitted' && a.checkPassed;

const minutes = (ms: number) => `${ms / 60_000} min`;
const dollars = (n: number) => `$${n.toFixed(2)}`;

/**
 * Fixes a lower limit would have cut: those that used more than `candidate`. Exact for
 * model calls, which the agent checks before each call. Exact for time too: every model
 * call and command runs with the time left as its timeout, and `durationMs` runs on the
 * same clock as the wall budget. For cost it's an upper bound: the agent checks spend
 * before each call, so a fix whose last call crossed the candidate would still have landed.
 */
export function cutCount(fixes: readonly number[], candidate: number): number {
  return fixes.filter((v) => v > candidate).length;
}

function whatIf(
  label: string,
  current: number,
  candidates: readonly number[],
  values: number[],
  fmt: (n: number) => string,
): string {
  const shown = candidates.filter((c) => c <= current);
  if (shown.length === 0) return `No ${label} candidate at or below the current ${fmt(current)}.`;
  return table(
    [label, 'fixes cut'],
    shown.map((c) => [fmt(c), `${cutCount(values, c)} of ${values.length} fixes cut`]),
  );
}

/** Per-tier budgets, the shape of ESCALATION_THRESHOLD. */
export type Threshold = Readonly<Record<Tier, Readonly<TierBudget>>>;

function tierSection(tier: Tier, attempts: Attempt[], limits: Readonly<TierBudget>): string {
  const out = [`### Tier ${tier}\n`];
  out.push(
    `Current limits: ${limits.stepLimit} model calls, ${dollars(limits.costLimitUsd)}, ` +
      `${minutes(limits.wallTimeLimitMs)}.\n`,
  );
  if (attempts.length === 0) {
    out.push('no attempts');
    return out.join('\n');
  }

  const count = (status: Attempt['exitStatus']) =>
    String(attempts.filter((a) => a.exitStatus === status).length);
  const fixes = attempts.filter(isFix);
  const other = attempts.filter((a) => a.exitStatus !== 'submitted' && !isLimitHit(a));
  out.push(
    table(
      [
        'attempts',
        'submitted',
        'fixed',
        'step limit',
        'cost limit',
        'time limit',
        'other exits',
        'false escalations',
      ],
      [
        [
          String(attempts.length),
          count('submitted'),
          String(fixes.length),
          count('step_limit'),
          count('cost_limit'),
          count('time_limit'),
          String(other.length),
          String(attempts.filter((a) => isLimitHit(a) && a.checkPassed).length),
        ],
      ],
    ),
  );

  if (fixes.length === 0) {
    out.push('\nno fixed attempts, so no usage or what-if tables');
    return out.join('\n');
  }

  const calls = fixes.map((a) => a.modelCalls);
  const cost = fixes.map((a) => a.costUsd);
  const ms = fixes.map((a) => a.durationMs);
  const stat = (values: number[], fmt: (n: number | null) => string) =>
    [50, 90, 100].map((p) => fmt(percentile(values, p)));
  out.push(`\nWhat the fixed attempts used (n = ${fixes.length}):\n`);
  out.push(
    table(
      ['', 'p50', 'p90', 'max'],
      [
        ['model calls', ...stat(calls, (n) => String(n))],
        ['cost', ...stat(cost, usd)],
        ['duration', ...[50, 90, 100].map((p) => sec(percentileSec(ms, p)))],
      ],
    ),
  );

  out.push('\nFixes that used more than a lower limit, so would have escalated instead:\n');
  out.push(whatIf('step limit', limits.stepLimit, CANDIDATES.stepLimit, calls, String));
  out.push('');
  out.push(whatIf('cost limit', limits.costLimitUsd, CANDIDATES.costLimitUsd, cost, dollars));
  out.push('');
  out.push(whatIf('time limit', limits.wallTimeLimitMs, CANDIDATES.wallTimeLimitMs, ms, minutes));
  return out.join('\n');
}

/**
 * Per-tier tuning tables over every attempt in `files`, against the current limits in
 * `threshold`. Run assertDevOnly first.
 */
export function renderTune(
  files: readonly EvalResults[],
  threshold: Threshold = ESCALATION_THRESHOLD,
): string {
  if (files.length === 0) throw new ReportError('no results files');
  // A threshold tuned on two models' runs fits neither, so a mix is refused, as in byConfig.
  const models = new Set(files.map((f) => f.model));
  if (models.size > 1) throw new ReportError(`results mix models: ${[...models].join(', ')}`);
  const out: string[] = [];
  const configs = files.map((f) => f.config).join(', ');
  out.push(`Results files: ${files.length} (${configs}). Model: ${[...models].join(', ')}.`);
  const warnings = files.flatMap((f) => incomplete(f).map((w) => `${f.config} ${w}`));
  if (warnings.length > 0) out.push(`\nIncomplete: ${warnings.join('; ')}.`);
  out.push(
    '\nRuns were cut at the current limits, so this data can only show what a lower limit ' +
      'would do, not a higher one. Candidates above the current limit are left out. A fix ' +
      'is cut when it used more than the candidate: exact for model calls and time, an ' +
      'upper bound for cost, since the agent checks spend before each call. False escalations are ' +
      'limit hits whose patch still passed check.sh; at the last tier of a run they page instead.\n',
  );

  const attempts = files.flatMap((f) => f.runs.flatMap((r) => r.attempts));
  for (const tier of TIERS) {
    out.push(
      tierSection(
        tier,
        attempts.filter((a) => a.tier === tier),
        threshold[tier],
      ),
    );
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
