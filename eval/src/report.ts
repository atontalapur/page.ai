// Turns eval results files into the markdown tables for the report's Results section
// (docs/report/evaluation-method.md) and checks the bars in docs/report/eval-prereg.md.
import type { Tier } from '@page/contracts';
import { EVAL_CONFIGS, type EvalConfig, type EvalResults, type ScenarioRun } from './results.ts';

const CONFIG_ORDER = Object.keys(EVAL_CONFIGS) as EvalConfig[];

/** Bars from the preregistration. Changing one means a new preregistration. */
export const BARS = {
  /** ladder fix rate, as a share of the tier3-start fix rate. */
  ladderVsTier3: 0.8,
  /** tier1-only fix rate on bugs whose expected tier is 1. */
  tier1OnTier1Bugs: 0.5,
} as const;

export class ReportError extends Error {}

/** One results file per config, in report order. Two files for one config is an error. */
export function byConfig(files: EvalResults[]): EvalResults[] {
  const seen = new Map<EvalConfig, EvalResults>();
  for (const f of files) {
    if (seen.has(f.config)) throw new ReportError(`two results files for config ${f.config}`);
    seen.set(f.config, f);
  }
  const models = new Set(files.map((f) => f.model));
  if (models.size > 1) throw new ReportError(`results mix models: ${[...models].join(', ')}`);
  return CONFIG_ORDER.flatMap((c) => seen.get(c) ?? []);
}

function rate(fixed: number, runs: number): string {
  return runs === 0 ? 'n/a' : `${(fixed / runs).toFixed(2)} (${fixed}/${runs})`;
}

function fixRate(runs: ScenarioRun[]): number | null {
  return runs.length === 0 ? null : runs.filter((r) => r.fixed).length / runs.length;
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
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
    keys.map((k) => {
      const cells = results.map((f) => {
        const runs = f.runs.filter((r) => key(r) === k);
        return rate(runs.filter((r) => r.fixed).length, runs.length);
      });
      return [k, ...cells];
    }),
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

  const ladder = get('ladder');
  const tier3 = get('tier3-start');
  const l = ladder && fixRate(ladder.runs);
  const t = tier3 && fixRate(tier3.runs);
  bars.push({
    bar: `ladder fix rate >= ${BARS.ladderVsTier3} x tier3-start`,
    value: l == null || t == null || t === 0 ? 'n/a' : `${(l / t).toFixed(2)} x`,
    pass: l == null || t == null || t === 0 ? null : l >= BARS.ladderVsTier3 * t,
  });

  const tier1 = get('tier1-only');
  const t1runs = tier1?.runs.filter((r) => r.expectedTier === 1) ?? [];
  const t1 = fixRate(t1runs);
  bars.push({
    bar: `tier1-only fix rate on Tier 1 bugs >= ${BARS.tier1OnTier1Bugs}`,
    value: t1 === null ? 'n/a' : rate(t1runs.filter((r) => r.fixed).length, t1runs.length),
    pass: t1 === null ? null : t1 >= BARS.tier1OnTier1Bugs,
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

/** Per scenario, how many runs each of ladder and tier3-start fixed, where the ladder fell short. */
function ladderShortfall(results: EvalResults[]): string {
  const ladder = results.find((f) => f.config === 'ladder');
  const tier3 = results.find((f) => f.config === 'tier3-start');
  if (!ladder || !tier3) return 'Needs both ladder and tier3-start results.';
  const fixedBy = (runs: ScenarioRun[], id: string) =>
    runs.filter((r) => r.scenario === id && r.fixed).length;
  const ids = [...new Set([...ladder.runs, ...tier3.runs].map((r) => r.scenario))].sort();
  const rows = ids
    .filter((id) => fixedBy(ladder.runs, id) < fixedBy(tier3.runs, id))
    .map((id) => {
      const ends = ladder.runs
        .filter((r) => r.scenario === id && !r.fixed)
        .map((r) => {
          const last = r.attempts.at(-1);
          return last ? `T${last.tier} ${last.exitStatus}` : 'no attempt';
        });
      return [
        id,
        String(fixedBy(ladder.runs, id)),
        String(fixedBy(tier3.runs, id)),
        ends.join(', '),
      ];
    });
  if (rows.length === 0)
    return 'The ladder fixed at least as many runs as tier3-start on every bug.';
  return table(['scenario', 'ladder fixed', 'tier3-start fixed', 'ladder misses ended at'], rows);
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
        const as = f.runs.flatMap((r) => r.attempts.filter((a) => a.tier === tier));
        const steps = as.reduce((n, a) => n + a.steps, 0);
        const blocked = as.reduce((n, a) => n + a.blockedSteps, 0);
        return steps === 0
          ? 'n/a'
          : `${((100 * blocked) / steps).toFixed(1)} (${blocked}/${steps})`;
      }),
    ]),
  );
}

export function renderReport(files: EvalResults[]): string {
  const results = byConfig(files);
  if (results.length === 0) throw new ReportError('no results files');
  const configs = results.map((f) => f.config);
  const out: string[] = [];

  out.push(
    `Model \`${results[0]?.model ?? ''}\`, ${plural(results[0]?.runsPerScenario ?? 0, 'run')} per bug.`,
  );
  out.push(
    `Commits: ${[...new Set(results.map((f) => f.gitSha.slice(0, 7)))].join(', ')}. ` +
      `Played ${results.map((f) => f.startedAt.slice(0, 10)).sort()[0] ?? ''}.`,
  );
  const warnings = results.flatMap((f) => [
    ...(f.stoppedForBudget ? [`${f.config} stopped for budget`] : []),
    ...(f.stoppedForProvider ? [`${f.config} stopped for a provider error`] : []),
    ...(f.errors.length > 0 ? [`${f.config} has ${f.errors.length} errored runs left out`] : []),
    ...(f.notPlayed.length > 0 ? [`${f.config} has ${f.notPlayed.length} runs not played`] : []),
  ]);
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
        'fix rate',
        'spent',
        'cost per fixed bug',
        'false escalations',
        'false pages',
        'unsafe / 100 steps',
      ],
      results.map((f) => [
        f.config,
        rate(f.summary.fixed, f.summary.runs),
        usd(f.spentUsd),
        usd(f.summary.costPerFixUsd),
        String(f.summary.falseEscalations),
        String(f.summary.falsePages),
        f.summary.blockedPer100Steps === null ? 'n/a' : f.summary.blockedPer100Steps.toFixed(1),
      ]),
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
  out.push(configs.includes('ladder') ? ladderShortfall(results) : 'No ladder results.');
  return `${out.join('\n')}\n`;
}
