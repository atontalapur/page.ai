// Turns eval results files into the series behind the report's Results charts. Every value
// comes from the same functions as the tables in report.ts, so a chart and its table can't
// disagree. chart-svg.ts draws them.
import {
  byClass,
  byConfig,
  byExpectedTier,
  groupSummaries,
  incomplete,
  percentileSec,
  plannedIds,
  rateLabel,
  ReportError,
  sec,
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

function overall(results: EvalResults[]): Cell[] {
  return results.map((f) => ({ config: f.config, summary: summarize(f.runs) }));
}

function rateChart(
  results: EvalResults[],
  id: string,
  title: string,
  key: GroupKey | null,
): BarChart {
  const groups =
    key === null ? [{ key: 'all bugs', cells: overall(results) }] : groupSummaries(results, key);
  return {
    kind: 'bars',
    id,
    title,
    xLabel: 'fix rate (fixed runs / runs)',
    xMax: 1,
    xFormat: 'rate',
    groups: groups.map((g) => ({
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
  const results = byConfig(files);
  const first = results[0];
  if (!first) throw new ReportError('no results files');

  const played = new Set(results.flatMap((f) => f.runs.map((r) => r.scenario))).size;
  const shas = [...new Set(results.map((f) => f.gitSha.slice(0, 7)))].join(', ');
  const cells = overall(results);
  const counts = (n: (c: Cell) => number): Bar[] =>
    cells.map((c) => ({
      config: c.config,
      value: n(c),
      label: `${n(c)} in ${c.summary.runs} runs`,
    }));

  return {
    subtitle: `${first.model}, ${played} of ${plannedIds(first).length} planned bugs played, commit ${shas}`,
    notes: results.flatMap((f) => incomplete(f).map((w) => `${f.config} ${w}`)),
    configs: results.map((f) => f.config),
    charts: [
      rateChart(results, 'fix-rate', 'Fix rate', null),
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
        xLabel: 'count',
        xMax: Math.max(
          1,
          ...cells.flatMap((c) => [c.summary.falseEscalations, c.summary.falsePages]),
        ),
        xFormat: 'count',
        groups: [
          { label: 'false escalations', bars: counts((c) => c.summary.falseEscalations) },
          { label: 'false pages', bars: counts((c) => c.summary.falsePages) },
        ],
      },
    ],
  };
}
