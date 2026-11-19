import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chartData, type BarChart, type Chart, type StripChart } from './chart-data.ts';
import { loadResultsFile, ReportError } from './report.ts';
import { attempt, results, run } from './test-utils.ts';

const bars = (charts: Chart[], id: string) => {
  const c = charts.find((x) => x.id === id);
  if (c?.kind !== 'bars') throw new Error(`no bar chart ${id}`);
  return c;
};
const strips = (charts: Chart[], id: string) => {
  const c = charts.find((x) => x.id === id);
  if (c?.kind !== 'strip') throw new Error(`no strip chart ${id}`);
  return c;
};
const labels = (c: BarChart) => c.groups.map((g) => [g.label, ...g.bars.map((b) => b.label)]);
const rows = (c: StripChart) => c.rows.map((r) => [r.config, r.label]);

describe('chartData', () => {
  it('orders configs as the report does and keeps one bar per config', () => {
    const set = chartData([
      results('ladder', [run('a', true)]),
      results('tier1-only', [run('a', false)]),
    ]);
    expect(set.configs).toEqual(['tier1-only', 'ladder']);
    expect(labels(bars(set.charts, 'fix-rate'))).toEqual([
      ['all bugs', '0.00 (0/1)', '1.00 (1/1)'],
    ]);
  });

  it('groups by class and by expected tier', () => {
    const set = chartData([
      results('tier1-only', [
        run('a', true),
        run('b', false, { class: 'database', expectedTier: 2 }),
      ]),
    ]);
    expect(labels(bars(set.charts, 'fix-rate-by-class'))).toEqual([
      ['database', '0.00 (0/1)'],
      ['frontend', '1.00 (1/1)'],
    ]);
    expect(labels(bars(set.charts, 'fix-rate-by-expected-tier'))).toEqual([
      ['Tier 1', '1.00 (1/1)'],
      ['Tier 2', '0.00 (0/1)'],
    ]);
  });

  it('groups by the tier a run landed at, with paged runs apart', () => {
    const set = chartData([
      results('ladder', [
        run('a', true),
        run('b', false, {
          attempts: [attempt(1, { exitStatus: 'step_limit' }), attempt(2, { checkPassed: false })],
          tierLanded: 2,
          paged: false,
        }),
        run('c', false),
      ]),
      results('tier1-only', [run('a', true), run('b', true), run('c', true)]),
    ]);
    expect(labels(bars(set.charts, 'fix-rate-by-tier-landed'))).toEqual([
      ['Tier 1', '1.00 (3/3)', '1.00 (1/1)'],
      ['Tier 2', 'n/a', '0.00 (0/1)'],
      ['paged', 'n/a', '0.00 (0/1)'],
    ]);
  });

  it('counts refused calls per 100 steps at the tier each attempt ran', () => {
    const set = chartData([
      results('ladder', [
        run('a', true, {
          attempts: [
            attempt(1, { exitStatus: 'step_limit', steps: 20, blockedSteps: 3 }),
            attempt(2, { steps: 10, blockedSteps: 0 }),
          ],
          tierLanded: 2,
        }),
      ]),
      results('tier1-only', [run('a', true, { attempts: [attempt(1, { blockedSteps: 1 })] })]),
    ]);
    const c = bars(set.charts, 'unsafe-attempts');
    expect(c.xFormat).toBe('number');
    expect(c.xMax).toBe(15);
    expect(labels(c)).toEqual([
      ['Tier 1', '10.0 (1/10)', '15.0 (3/20)'],
      ['Tier 2', 'n/a', '0.0 (0/10)'],
    ]);
    expect(c.groups[1]?.bars.map((b) => b.value)).toEqual([0, 0]);
  });

  it('prices kept runs per fixed run, and draws no bar when nothing was fixed', () => {
    const set = chartData([
      results('tier1-only', [run('a', true, { costUsd: 0.02 }), run('b', true, { costUsd: 0.04 })]),
      results('ladder', [run('a', false), run('b', false)]),
    ]);
    const cost = bars(set.charts, 'cost-per-fixed-bug');
    expect(cost.xMax).toBe(0.03);
    expect(cost.groups[0]?.bars).toEqual([
      { config: 'tier1-only', value: 0.03, label: '$0.0300 (2 fixed)' },
      { config: 'ladder', value: 0, label: 'n/a (0 fixed)' },
    ]);
  });

  it('keeps every time, unrounded, with the percentiles the table shows', () => {
    const set = chartData([
      results('ladder', [
        run('a', true, { timeToFixMs: 1500 }),
        run('b', true, { timeToFixMs: 2500 }),
        run('c', false, { timeToPageMs: 9000 }),
      ]),
    ]);
    const fix = strips(set.charts, 'time-to-fix').rows[0];
    expect(fix).toMatchObject({ sec: [1.5, 2.5], p50: 2, p90: 3, label: 'n=2, p50 2s, p90 3s' });
    expect(rows(strips(set.charts, 'time-to-page'))).toEqual([['ladder', 'n=1, p50 9s, p90 9s']]);
  });

  it('labels an empty strip n/a', () => {
    const set = chartData([results('tier3-start', [run('a', true)])]);
    expect(strips(set.charts, 'time-to-page').rows[0]).toMatchObject({
      sec: [],
      p50: null,
      label: 'n=0, p50 n/a, p90 n/a',
    });
  });

  it('counts false escalations per attempt and false pages per run', () => {
    const set = chartData([
      results('ladder', [
        run('a', true, {
          attempts: [
            attempt(1, { exitStatus: 'step_limit' }),
            attempt(2, { exitStatus: 'step_limit' }),
            attempt(3),
          ],
          falseEscalations: 2,
        }),
        run('b', false, { falsePage: true }),
      ]),
      results('tier1-only', [run('a', true)], { skipped: [{ scenario: 'b', reason: 'ops' }] }),
    ]);
    const c = bars(set.charts, 'false-escalations');
    expect(labels(c)).toEqual([
      ['false escalations', '0 escalations in 1 run', '2 escalations in 2 runs'],
      ['false pages', '0 of 1 run paged', '1 of 2 runs paged'],
    ]);
    expect(c.xMax).toBe(2);
  });

  it('notes runs left out, and names model, bugs and commit', () => {
    const set = chartData([
      results('ladder', [run('a', true)], { skipped: [{ scenario: 'b', reason: 'ops' }] }),
    ]);
    expect(set.subtitle).toBe('m, 1 of 2 planned bugs played, commit abcdef1');
    expect(set.notes).toEqual(['ladder 1 scenario skipped']);
  });

  it('names every commit when the files ran at more than one', () => {
    const set = chartData([
      results('ladder', [run('a', true)]),
      results('tier1-only', [run('a', true)], { gitSha: '1234567890' }),
    ]);
    expect(set.subtitle).toBe('m, 1 of 1 planned bugs played, commits 1234567, abcdef1');
  });

  it('refuses what the report refuses', () => {
    expect(() => chartData([])).toThrow(ReportError);
    expect(() => chartData([results('ladder', []), results('ladder', [])])).toThrow(ReportError);
  });
});

// The dev run's committed results: the charts in docs/report/evaluation-method.md must show
// the numbers in its tables.
describe('chartData on the dev results', () => {
  const dir = fileURLToPath(new URL('../results/', import.meta.url));
  const files = [
    '2026-11-10T01-54-52Z-tier1-only.json',
    '2026-11-10T01-54-55Z-tier3-start.json',
    '2026-11-10T01-54-58Z-ladder.json',
  ];

  it('matches the Results tables', async () => {
    const set = chartData(await Promise.all(files.map((f) => loadResultsFile(dir + f))));
    expect(set.subtitle).toBe(
      'deepseek/deepseek-v4.1-flash, 18 of 20 planned bugs played, commit b862244',
    );
    expect(labels(bars(set.charts, 'fix-rate'))).toEqual([
      ['all bugs', '0.94 (51/54)', '0.94 (51/54)', '0.94 (51/54)'],
    ]);
    expect(labels(bars(set.charts, 'fix-rate-by-class'))).toEqual([
      ['backend-api', '0.93 (14/15)', '0.93 (14/15)', '0.80 (12/15)'],
      ['database', '1.00 (15/15)', '0.93 (14/15)', '1.00 (15/15)'],
      ['frontend', '1.00 (15/15)', '1.00 (15/15)', '1.00 (15/15)'],
      ['infra-config', '0.78 (7/9)', '0.89 (8/9)', '1.00 (9/9)'],
    ]);
    expect(labels(bars(set.charts, 'fix-rate-by-expected-tier'))).toEqual([
      ['Tier 1', '0.90 (27/30)', '0.97 (29/30)', '0.93 (28/30)'],
      ['Tier 2', '1.00 (24/24)', '0.92 (22/24)', '0.96 (23/24)'],
    ]);
    expect(labels(bars(set.charts, 'cost-per-fixed-bug'))).toEqual([
      ['all bugs', '$0.0086 (51 fixed)', '$0.0069 (51 fixed)', '$0.0096 (51 fixed)'],
    ]);
    expect(rows(strips(set.charts, 'time-to-fix'))).toEqual([
      ['tier1-only', 'n=51, p50 159s, p90 305s'],
      ['tier3-start', 'n=51, p50 172s, p90 321s'],
      ['ladder', 'n=51, p50 180s, p90 383s'],
    ]);
    expect(rows(strips(set.charts, 'time-to-page'))).toEqual([
      ['tier1-only', 'n=3, p50 8s, p90 841s'],
      ['tier3-start', 'n=3, p50 7s, p90 9s'],
      ['ladder', 'n=1, p50 74s, p90 74s'],
    ]);
    expect(labels(bars(set.charts, 'false-escalations'))).toEqual([
      [
        'false escalations',
        '0 escalations in 54 runs',
        '0 escalations in 54 runs',
        '2 escalations in 54 runs',
      ],
      ['false pages', '1 of 54 runs paged', '0 of 54 runs paged', '0 of 54 runs paged'],
    ]);
    // Runs by tier landed: 51/0/0/3, 0/0/51/3 and 51/2/0/1, the denominators below.
    expect(labels(bars(set.charts, 'fix-rate-by-tier-landed'))).toEqual([
      ['Tier 1', '1.00 (51/51)', 'n/a', '0.96 (49/51)'],
      ['Tier 2', 'n/a', 'n/a', '1.00 (2/2)'],
      ['Tier 3', 'n/a', '1.00 (51/51)', 'n/a'],
      ['paged', '0.00 (0/3)', '0.00 (0/3)', '0.00 (0/1)'],
    ]);
    expect(labels(bars(set.charts, 'unsafe-attempts'))).toEqual([
      ['Tier 1', '7.3 (61/836)', 'n/a', '7.3 (61/838)'],
      ['Tier 2', 'n/a', 'n/a', '6.0 (3/50)'],
      ['Tier 3', 'n/a', '6.8 (63/927)', 'n/a'],
    ]);
  });
});
