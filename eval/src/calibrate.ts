// Calibrating the confidence threshold (Amendment 5 in docs/report/eval-prereg.md): how the
// scores of submitted fixes split between patches that pass check.sh and ones that don't,
// what each candidate threshold would have escalated, and the threshold the preregistered
// rule picks. The check runs on every attempt and the agent never sees its score, so one
// recorded score says what any threshold would have done with that attempt.
import type { Confidence, Tier } from '@page/contracts';
import { plural, table } from './report.ts';
import type { Attempt } from './results.ts';
import { escalationReason } from './runner.ts';

/**
 * The thresholds the rule chooses from. A code fix scores a sum of 0.5, 0.3 and 0.2
 * (CONFIDENCE_WEIGHTS), so these are the only points where moving the threshold changes
 * which fixes fall under it.
 */
export const CONFIDENCE_CANDIDATES = [0.2, 0.3, 0.5, 0.7, 0.8, 1] as const;

/** A candidate may escalate at most 1 passing fix per this many at the tier. */
export const PASSING_FIXES_PER_FALSE_ESCALATION = 50;

/** A tier with fewer scored code fixes keeps its threshold. */
export const MIN_CODE_FIXES = 20;

/** One scored submit and whether its patch passed check.sh. */
export interface ScoredFix {
  confidence: Confidence;
  passed: boolean;
}

/** A tier's submitted attempts, split the way the rule reads them. */
export interface TierSubmits {
  /** Scored code fixes: the score has `liveAfterChange` null. The rule reads only these. */
  code: ScoredFix[];
  /** Scored ops-only fixes, 0 or 1 on the live app, which every candidate treats the same. */
  opsOnly: ScoredFix[];
  /** Submits with no score: the scorer threw, or the file predates scoring. */
  unscored: number;
}

export function tierSubmits(attempts: readonly Attempt[]): TierSubmits {
  const out: TierSubmits = { code: [], opsOnly: [], unscored: 0 };
  for (const a of attempts) {
    if (a.exitStatus !== 'submitted') continue;
    if (a.confidence == null) {
      out.unscored++;
      continue;
    }
    const fix = { confidence: a.confidence, passed: a.checkPassed };
    (a.confidence.liveAfterChange === null ? out.code : out.opsOnly).push(fix);
  }
  return out;
}

/** What one candidate threshold would have done with a tier's code fixes. */
export interface CandidateRow {
  threshold: number;
  /** Passing fixes under it: each would escalate, or page at the config's last tier. */
  falseEscalations: number;
  /** Failing fixes under it: wrong patches that would no longer land. */
  caught: number;
  /** Its false escalations are at most 1 in PASSING_FIXES_PER_FALSE_ESCALATION passing fixes. */
  allowed: boolean;
}

// The daemon's test (isLowConfidence in @page/agent), at a candidate value.
const under = (fix: ScoredFix, threshold: number) => fix.confidence.score < threshold;

export function candidateRows(fixes: readonly ScoredFix[]): CandidateRow[] {
  const passing = fixes.filter((f) => f.passed).length;
  return CONFIDENCE_CANDIDATES.map((threshold) => {
    const falseEscalations = fixes.filter((f) => f.passed && under(f, threshold)).length;
    const caught = fixes.filter((f) => !f.passed && under(f, threshold)).length;
    return {
      threshold,
      falseEscalations,
      caught,
      allowed: falseEscalations * PASSING_FIXES_PER_FALSE_ESCALATION <= passing,
    };
  });
}

/** The rule's threshold for one tier, and why. */
export interface ThresholdPick {
  threshold: number;
  why: string;
}

/**
 * Amendment 5's rule for one tier. A tier with fewer than MIN_CODE_FIXES scored code fixes
 * keeps `current`. Otherwise the pick is the allowed candidate that catches the most failing
 * fixes; ties go to fewer false escalations, then to `current`, then to the lower candidate.
 * With no allowed candidate, the lowest one: the scorer gives too many passing fixes a 0.
 */
export function pickThreshold(fixes: readonly ScoredFix[], current: number): ThresholdPick {
  if (fixes.length < MIN_CODE_FIXES) {
    const n = `${fixes.length} scored code ${fixes.length === 1 ? 'fix' : 'fixes'}`;
    return {
      threshold: current,
      why: `${n}, fewer than ${MIN_CODE_FIXES}, so it keeps ${current}`,
    };
  }
  const allowed = candidateRows(fixes).filter((r) => r.allowed);
  const [best] = allowed.sort(
    (a, b) =>
      b.caught - a.caught ||
      a.falseEscalations - b.falseEscalations ||
      Number(b.threshold === current) - Number(a.threshold === current) ||
      a.threshold - b.threshold,
  );
  if (best === undefined) {
    const lowest = CONFIDENCE_CANDIDATES[0];
    return {
      threshold: lowest,
      why:
        `no candidate keeps false escalations to 1 in ${PASSING_FIXES_PER_FALSE_ESCALATION} ` +
        `passing fixes, so it takes the lowest, ${lowest}; the scorer gives passing fixes a 0`,
    };
  }
  return {
    threshold: best.threshold,
    why:
      `the allowed candidate that catches the most failing fixes (${best.caught}), with ` +
      `${plural(best.falseEscalations, 'false escalation')}`,
  };
}

const PARTS = [
  ['changes code', 'changesCode'],
  ['tests pass', 'testsPass'],
  ['checks pass', 'checksPass'],
  ['reproduced', 'reproduced'],
] as const satisfies readonly (readonly [string, keyof Confidence])[];

const fmt = (n: number) => String(Math.round(n * 100) / 100);

function codeTables(fixes: readonly ScoredFix[]): string[] {
  const passed = fixes.filter((f) => f.passed);
  const failed = fixes.filter((f) => !f.passed);
  const scores = [...new Set(fixes.map((f) => f.confidence.score))].sort((a, b) => a - b);
  const at = (group: readonly ScoredFix[], score: number) =>
    String(group.filter((f) => f.confidence.score === score).length);
  const held = (group: readonly ScoredFix[], part: keyof Confidence) =>
    String(group.filter((f) => f.confidence[part] === true).length);
  const out = ['Scores of the code fixes:\n'];
  out.push(
    table(
      ['score', 'passed', 'failed'],
      scores.map((s) => [fmt(s), at(passed, s), at(failed, s)]),
    ),
  );
  out.push('\nParts that held:\n');
  out.push(
    table(
      ['part', `passed (n = ${passed.length})`, `failed (n = ${failed.length})`],
      PARTS.map(([label, part]) => [label, held(passed, part), held(failed, part)]),
    ),
  );
  out.push(
    '\nEach candidate: passing fixes under it (false escalations, or false pages at the last ' +
      'tier) and failing fixes under it (wrong patches caught):\n',
  );
  out.push(
    table(
      ['threshold', 'false escalations', 'wrong patches caught', 'allowed'],
      candidateRows(fixes).map((r) => [
        fmt(r.threshold),
        `${r.falseEscalations} of ${passed.length}`,
        `${r.caught} of ${failed.length}`,
        r.allowed ? 'yes' : 'no',
      ]),
    ),
  );
  return out;
}

function opsTable(fixes: readonly ScoredFix[]): string {
  const count = (live: boolean, passed: boolean) =>
    String(
      fixes.filter((f) => f.confidence.liveAfterChange === live && f.passed === passed).length,
    );
  return table(
    ['live after change (score)', 'passed', 'failed'],
    [
      ['yes (1)', count(true, true), count(true, false)],
      ['no (0)', count(false, true), count(false, false)],
    ],
  );
}

/** Why each attempt at a tier moved on: budget_exhausted, low_confidence, or neither. */
function reasons(attempts: readonly Attempt[]): string {
  const counts = new Map<string, number>();
  for (const a of attempts) {
    const reason = escalationReason(a);
    if (reason !== undefined) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const listed = [...counts].map(([reason, n]) => `${reason} ${n}`);
  return listed.length === 0 ? 'none' : listed.join(', ');
}

function tierSection(
  tier: Tier,
  attempts: readonly Attempt[],
  current: number,
  pick: ThresholdPick,
): string {
  const out = [`### Tier ${tier} confidence\n`];
  const submits = tierSubmits(attempts);
  const passed = submits.code.filter((f) => f.passed).length;
  out.push(
    `Current threshold: ${current}. Scored code fixes: ${submits.code.length} (${passed} passed, ` +
      `${submits.code.length - passed} failed). Ops-only fixes: ${submits.opsOnly.length}. ` +
      `Unscored submits: ${submits.unscored}. Escalation reasons as played (paged at a ` +
      `config's last tier): ${reasons(attempts)}.`,
  );
  if (submits.code.length > 0) out.push('', ...codeTables(submits.code));
  if (submits.opsOnly.length > 0) {
    out.push('\nOps-only fixes, which every candidate treats the same:\n');
    out.push(opsTable(submits.opsOnly));
  }
  out.push(`\nPick: ${pick.threshold}, ${pick.why}.`);
  return out.join('\n');
}

const TIERS = [1, 2, 3] as const satisfies readonly Tier[];

/**
 * Per-tier confidence tables over every attempt in `attempts`, and Amendment 5's pick for
 * each tier against the current thresholds. Tier 2 takes Tier 1's pick: no single-tier
 * config plays it, and it scores the same code task on the same parts.
 */
export function renderConfidence(
  attempts: readonly Attempt[],
  current: Readonly<Record<Tier, number>>,
): string {
  const at = (tier: Tier) => attempts.filter((a) => a.tier === tier);
  const pickAt = (tier: Tier) => pickThreshold(tierSubmits(at(tier)).code, current[tier]);
  const tier1 = pickAt(1);
  const picks: Record<Tier, ThresholdPick> = {
    1: tier1,
    2: {
      threshold: tier1.threshold,
      why: "Tier 1's pick, since no single-tier config plays Tier 2",
    },
    3: pickAt(3),
  };
  const out = [
    'Confidence: every submitted fix is scored, and its check runs whatever the score, so ' +
      'each candidate threshold can be judged on the same attempts. A fix scoring under the ' +
      "threshold escalates (or pages at a config's last tier). The rule (Amendment 5 in " +
      `docs/report/eval-prereg.md) allows a candidate with at most 1 false escalation per ` +
      `${PASSING_FIXES_PER_FALSE_ESCALATION} passing code fixes and picks the allowed one that ` +
      'catches the most failing fixes.\n',
  ];
  for (const tier of TIERS) {
    out.push(tierSection(tier, at(tier), current[tier], picks[tier]));
    out.push('');
  }
  out.push(`Picks: ${TIERS.map((tier) => `Tier ${tier} ${picks[tier].threshold}`).join(', ')}.`);
  return out.join('\n');
}
