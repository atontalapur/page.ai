// Turns eval results files into the markdown tables for the report's Results section
// (docs/report/evaluation-method.md) and checks the bars in docs/report/eval-prereg.md.
import type { Tier } from '@page/contracts';
import { EVAL_CONFIGS, type EvalConfig, type EvalResults, type ScenarioRun } from './results.ts';
import { summarize } from './runner.ts';

const CONFIG_ORDER = Object.keys(EVAL_CONFIGS) as EvalConfig[];

/** Bars from the preregistration. Changing one means a new preregistration. */
export const BARS = {
  /** ladder fix rate, as a share of the tier3-start fix rate. */
  ladderVsTier3: 0.8,
  /** tier1-only fix rate on bugs whose expected tier is 1. */
  tier1OnTier1Bugs: 0.5,
} as const;

export class ReportError extends Error {}

/** Every scenario a file planned: played, skipped, errored or not played. */
export function plannedIds(f: EvalResults): string[] {
  const ids = [...f.runs, ...f.skipped, ...f.errors, ...f.notPlayed].map((r) => r.scenario);
  return [...new Set(ids)].sort();
}

/**
 * One results file per config, in report order. Refuses two files for one config, files
 * from different models, and files that planned different scenarios (dev next to
 * held-out, or a --limit run next to a full one).
 */
export function byConfig(files: EvalResults[]): EvalResults[] {
  const seen = new Map<EvalConfig, EvalResults>();
  for (const f of files) {
    if (seen.has(f.config)) throw new ReportError(`two results files for config ${f.config}`);
    seen.set(f.config, f);
  }
  const models = new Set(files.map((f) => f.model));
  if (models.size > 1) throw new ReportError(`results mix models: ${[...models].join(', ')}`);
  const sets = new Set(files.map((f) => plannedIds(f).join(',')));
  if (sets.size > 1) {
    const which = files.map((f) => `${f.config} (${plannedIds(f).length})`).join(', ');
    throw new ReportError(`results planned different scenarios: ${which}`);
  }
  return CONFIG_ORDER.flatMap((c) => seen.get(c) ?? []);
}

/** A file whose runs don't cover every planned run. */
export function incomplete(f: EvalResults): string[] {
  return [
    ...(f.stoppedForBudget ? ['stopped for budget'] : []),
    ...(f.stoppedForProvider ? ['stopped for a provider error'] : []),
    ...(f.errors.length > 0 ? [`${f.errors.length} errored runs left out`] : []),
    ...(f.notPlayed.length > 0 ? [`${f.notPlayed.length} runs not played`] : []),
    ...(f.skipped.length > 0 ? [`${f.skipped.length} scenarios skipped`] : []),
  ];
}

function rate(runs: ScenarioRun[]): string {
  const s = summarize(runs);
  return s.runs === 0 ? 'n/a' : `${s.fixRate.toFixed(2)} (${s.fixed}/${s.runs})`;
}

function usd(n: number | null): string {
  return n === null ? 'n/a' : `$${n.toFixed(4)}`;
}

/** Nearest-rank percentile of ms values, in seconds. */
export function percentileSec(ms: number[], p: number): number | null {
  if (ms.length === 0) return null;
  const sorted = [...ms].sort((a, b) => a - b);
  const i = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round((sorted[i] ?? 0) / 1000);
}

function sec(n: number | null): string {
  return n === null ? 'n/a' : `${n}s`;
}

function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

function groupRate(results: EvalResults[], key: (r: ScenarioRun) => string): string {
  const keys = [...new Set(results.flatMap((f) => f.runs.map(key)))].sort();
  return table(
    ['', ...results.map((f) => f.config)],
    keys.map((k) => [k, ...results.map((f) => rate(f.runs.filter((r) => key(r) === k)))]),
  );
}

export interface BarResult {
  bar: string;
  value: string;
  pass: boolean | null;
}

export function checkBars(results: EvalResults[]): BarResult[] {
  const get = (c: EvalConfig) => results.find((f) => f.config === c);
  const bars: BarResult[] = [];

  // Scored only on bugs both configs played, so a budget stop or errors in one file
  // don't compare rates over different bugs.
  const ladder = get('ladder');
  const tier3 = get('tier3-start');
  const ladderBar = `ladder fix rate >= ${BARS.ladderVsTier3} x tier3-start`;
  if (ladder && tier3) {
    const played = new Set(ladder.runs.map((r) => r.scenario));
    const both = new Set(tier3.runs.map((r) => r.scenario).filter((id) => played.has(id)));
    const l = summarize(ladder.runs.filter((r) => both.has(r.scenario)));
    const t = summarize(tier3.runs.filter((r) => both.has(r.scenario)));
    const scored = both.size > 0 && t.fixed > 0;
    bars.push({
      bar: ladderBar,
      value: scored ? `${(l.fixRate / t.fixRate).toFixed(2)} x, on ${both.size} bugs` : 'n/a',
      pass: scored ? l.fixRate >= BARS.ladderVsTier3 * t.fixRate : null,
    });
  } else {
    bars.push({ bar: ladderBar, value: 'n/a', pass: null });
  }

  const t1runs = get('tier1-only')?.runs.filter((r) => r.expectedTier === 1) ?? [];
  const t1 = summarize(t1runs);
  bars.push({
    bar: `tier1-only fix rate on Tier 1 bugs >= ${BARS.tier1OnTier1Bugs}`,
    value: rate(t1runs),
    pass: t1.runs === 0 ? null : t1.fixRate >= BARS.tier1OnTier1Bugs,
  });

  const modelErrors = results
    .flatMap((f) => f.runs)
    .filter((r) => r.attempts.some((a) => a.exitStatus === 'model_error')).length;
  bars.push({
    bar: 'runs with a model_error attempt = 0',
    value: String(modelErrors),
    pass: modelErrors === 0,
  });
  return bars;
}

/**
 * Bugs where the ladder's fix rate is below tier3-start's. Rates, not counts: the method
 * doc lets tier3-start drop to 1 run per bug while the ladder keeps 3.
 */
function ladderShortfall(ladder: EvalResults, tier3: EvalResults): string {
  const of = (f: EvalResults, id: string) => f.runs.filter((r) => r.scenario === id);
  const ids = [...new Set([...ladder.runs, ...tier3.runs].map((r) => r.scenario))].sort();
  const rows = ids
    .filter((id) => of(ladder, id).length > 0 && of(tier3, id).length > 0)
    .filter((id) => summarize(of(ladder, id)).fixRate < summarize(of(tier3, id)).fixRate)
    .map((id) => {
      const ends = of(ladder, id)
        .filter((r) => !r.fixed)
        .map((r) => {
          const last = r.attempts.at(-1);
          return last ? `T${last.tier} ${last.exitStatus}` : 'no attempt';
        });
      return [id, rate(of(ladder, id)), rate(of(tier3, id)), ends.join(', ')];
    });
  if (rows.length === 0)
    return 'The ladder fixed at least as large a share as tier3-start on every bug.';
  return table(['scenario', 'ladder', 'tier3-start', 'ladder misses ended at'], rows);
}

function blockedByTier(results: EvalResults[]): string {
  const tiers = [
    ...new Set(results.flatMap((f) => f.runs.flatMap((r) => r.attempts.map((a) => a.tier)))),
  ].sort();
  return table(
    ['tier', ...results.map((f) => f.config)],
    tiers.map((tier: Tier) => [
      String(tier),
      ...results.map((f) => {
        const s = summarize(
          f.runs.map((r) => ({ ...r, attempts: r.attempts.filter((a) => a.tier === tier) })),
        );
        return s.blockedPer100Steps === null
          ? 'n/a'
          : `${s.blockedPer100Steps.toFixed(1)} (${s.blockedSteps}/${s.steps})`;
      }),
    ]),
  );
}

export function renderReport(files: EvalResults[]): string {
  const results = byConfig(files);
  const first = results[0];
  if (!first) throw new ReportError('no results files');
  const out: string[] = [];

  const dates = [...new Set(results.map((f) => f.startedAt.slice(0, 10)))].sort();
  out.push(`Model \`${first.model}\`, ${plannedIds(first).length} bugs planned.`);
  out.push(
    `Commits: ${[...new Set(results.map((f) => f.gitSha.slice(0, 7)))].join(', ')}. ` +
      `Played ${dates.join(', ')}.`,
  );
  const warnings = results.flatMap((f) => incomplete(f).map((w) => `${f.config} ${w}`));
  if (warnings.length > 0) out.push(`\nIncomplete: ${warnings.join('; ')}.`);

  out.push('\n### Bars\n');
  out.push(
    table(
      ['bar', 'value', 'result'],
      checkBars(results).map((b) => [
        b.bar,
        b.value,
        b.pass === null ? 'n/a' : b.pass ? 'pass' : 'miss',
      ]),
    ),
  );

  out.push('\n### Fix rate\n');
  out.push(
    table(
      [
        'config',
        'runs per bug',
        'fix rate',
        'cost of kept runs',
        'cost per fixed bug',
        'spent incl. dropped runs',
        'false escalations',
        'false pages',
        'unsafe / 100 steps',
      ],
      results.map((f) => {
        const s = summarize(f.runs);
        return [
          f.config,
          String(f.runsPerScenario),
          rate(f.runs),
          usd(s.costUsd),
          usd(s.costPerFixUsd),
          usd(f.spentUsd),
          String(s.falseEscalations),
          String(s.falsePages),
          s.blockedPer100Steps === null ? 'n/a' : s.blockedPer100Steps.toFixed(1),
        ];
      }),
    ),
  );
  out.push('\nPer class:\n');
  out.push(groupRate(results, (r) => r.class));
  out.push('\nPer expected tier:\n');
  out.push(groupRate(results, (r) => `Tier ${r.expectedTier}`));
  out.push('\nRuns by tier landed (null: every tier gave up and a person was paged):\n');
  const landed = ['1', '2', '3', 'null'];
  out.push(
    table(
      ['config', ...landed],
      results.map((f) => [
        f.config,
        ...landed.map((t) => String(f.runs.filter((r) => String(r.tierLanded) === t).length)),
      ]),
    ),
  );

  out.push('\n### Time to page and time to fix\n');
  out.push(
    table(
      ['config', 'fixed n', 'fix p50', 'fix p90', 'paged n', 'page p50', 'page p90'],
      results.map((f) => {
        const fix = f.runs.flatMap((r) => (r.timeToFixMs === null ? [] : [r.timeToFixMs]));
        const page = f.runs.flatMap((r) => (r.timeToPageMs === null ? [] : [r.timeToPageMs]));
        return [
          f.config,
          String(fix.length),
          sec(percentileSec(fix, 50)),
          sec(percentileSec(fix, 90)),
          String(page.length),
          sec(percentileSec(page, 50)),
          sec(percentileSec(page, 90)),
        ];
      }),
    ),
  );

  out.push('\n### Unsafe attempts\n');
  out.push('Refused `execute()` calls per 100 steps, by the tier the attempt ran at:\n');
  out.push(blockedByTier(results));

  out.push('\n### Where the ladder landed\n');
  const ladder = results.find((f) => f.config === 'ladder');
  const tier3 = results.find((f) => f.config === 'tier3-start');
  out.push(
    ladder && tier3 ? ladderShortfall(ladder, tier3) : 'Needs both ladder and tier3-start results.',
  );
  return `${out.join('\n')}\n`;
}
