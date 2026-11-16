// Turns eval results files into the series behind the report's Results charts. Every value
// comes from the same functions as the tables in report.ts, so a chart and its table can't
// disagree. chart-svg.ts draws them.
import {
  byClass,
  byExpectedTier,
  groupSummaries,
  incompleteNotes,
  percentileSec,
  plannedIds,
  rateLabel,
  reportFiles,
  sec,
  shortShas,
  times,
  usd,
  type Cell,
  type GroupKey,
} from './report.ts';
import type { EvalConfig, EvalResults } from './results.ts';
import { summarize } from './runner.ts';

export interface Bar {
  config: EvalConfig;
  value: number;
  /** The text the table shows for this cell. */
  label: string;
}

export interface BarGroup {
  label: string;
  bars: Bar[];
}

/** Horizontal bars, one per config, in groups. */
export interface BarChart {
  kind: 'bars';
  /** File name, without .svg. */
  id: string;
  title: string;
  xLabel: string;
  /** The x axis runs from 0 to at least this. */
  xMax: number;
  xFormat: 'rate' | 'usd' | 'count';
  groups: BarGroup[];
}

export interface Strip {
  config: EvalConfig;
  /** One value per run, in seconds, unrounded. */
  sec: number[];
  /** Nearest-rank percentiles in whole seconds, as the table shows them. */
  p50: number | null;
  p90: number | null;
  label: string;
}

/** One row of dots per config, one dot per run, with p50 and p90 marked. */
export interface StripChart {
  kind: 'strip';
  id: string;
  title: string;
  xLabel: string;
  rows: Strip[];
}

export type Chart = BarChart | StripChart;

export interface ChartSet {
  /** Model, bugs played, commits: one line under each title. */
  subtitle: string;
  /** Why some planned runs are missing, per config. Empty when none are. */
  notes: string[];
  configs: EvalConfig[];
  charts: Chart[];
}

const allBugs: GroupKey = () => 'all bugs';

function rateChart(results: EvalResults[], id: string, title: string, key: GroupKey): BarChart {
  return {
    kind: 'bars',
    id,
    title,
    xLabel: 'fix rate (fixed runs / runs)',
    xMax: 1,
    xFormat: 'rate',
    groups: groupSummaries(results, key).map((g) => ({
      label: g.key,
      bars: g.cells.map(({ config, summary }) => ({
        config,
        value: summary.fixRate,
        label: rateLabel(summary),
      })),
    })),
  };
}

function stripChart(
  results: EvalResults[],
  id: string,
  title: string,
  field: 'timeToFixMs' | 'timeToPageMs',
  what: string,
): StripChart {
  return {
    kind: 'strip',
    id,
    title,
    xLabel: `seconds from the exception to the ${what}`,
    rows: results.map((f) => {
      const ms = times(f, field);
      const p50 = percentileSec(ms, 50);
      const p90 = percentileSec(ms, 90);
      return {
        config: f.config,
        sec: ms.map((v) => v / 1000),
        p50,
        p90,
        label: `n=${ms.length}, p50 ${sec(p50)}, p90 ${sec(p90)}`,
      };
    }),
  };
}

export function chartData(files: EvalResults[]): ChartSet {
  const { results, first } = reportFiles(files);

  const played = new Set(results.flatMap((f) => f.runs.map((r) => r.scenario))).size;
  const shas = shortShas(results);
  const commits = `${shas.length > 1 ? 'commits' : 'commit'} ${shas.join(', ')}`;
  const cells: Cell[] = results.map((f) => ({ config: f.config, summary: summarize(f.runs) }));
  // summarize counts false escalations per attempt, so one run can escalate twice, and
  // false pages per run. The labels say which.
  const counts = (n: (c: Cell) => number, label: (n: number, runs: number) => string): Bar[] =>
    cells.map((c) => ({ config: c.config, value: n(c), label: label(n(c), c.summary.runs) }));
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

  return {
    subtitle: `${first.model}, ${played} of ${plannedIds(first).length} planned bugs played, ${commits}`,
    notes: incompleteNotes(results),
    configs: results.map((f) => f.config),
    charts: [
      rateChart(results, 'fix-rate', 'Fix rate', allBugs),
      rateChart(results, 'fix-rate-by-class', 'Fix rate by bug class', byClass),
      rateChart(results, 'fix-rate-by-expected-tier', 'Fix rate by expected tier', byExpectedTier),
      {
        kind: 'bars',
        id: 'cost-per-fixed-bug',
        title: 'Cost per fixed bug',
        xLabel: 'USD of kept runs per fixed run',
        xMax: Math.max(0, ...cells.map((c) => c.summary.costPerFixUsd ?? 0)),
        xFormat: 'usd',
        groups: [
          {
            label: 'all bugs',
            bars: cells.map(({ config, summary: s }) => ({
              config,
              value: s.costPerFixUsd ?? 0,
              label: `${usd(s.costPerFixUsd)} (${s.fixed} fixed)`,
            })),
          },
        ],
      },
      stripChart(results, 'time-to-fix', 'Time to fix', 'timeToFixMs', 'fix'),
      stripChart(results, 'time-to-page', 'Time to page', 'timeToPageMs', 'page'),
      {
        kind: 'bars',
        id: 'false-escalations',
        title: 'False escalations and false pages',
        xLabel: 'escalations, or runs paged',
        xMax: Math.max(
          1,
          ...cells.flatMap((c) => [c.summary.falseEscalations, c.summary.falsePages]),
        ),
        xFormat: 'count',
        groups: [
          {
            label: 'false escalations',
            bars: counts(
              (c) => c.summary.falseEscalations,
              (n, runs) => `${plural(n, 'escalation')} in ${plural(runs, 'run')}`,
            ),
          },
          {
            label: 'false pages',
            bars: counts(
              (c) => c.summary.falsePages,
              (n, runs) => `${n} of ${plural(runs, 'run')} paged`,
            ),
          },
        ],
      },
    ],
  };
}
