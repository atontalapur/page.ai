import { describe, expect, it } from 'vitest';
import { chartData, type ChartSet } from './chart-data.ts';
import { escapeXml, niceTicks, renderChart, seriesColor } from './chart-svg.ts';
import { results, run } from './test-utils.ts';

const set = (over: Partial<ChartSet> = {}): ChartSet => ({
  ...chartData([
    results('tier1-only', [run('a', true), run('b', false, { timeToPageMs: 841_000 })]),
    results('ladder', [run('a', true), run('b', true)]),
  ]),
  ...over,
});
const svg = (id: string, s = set()) => {
  const chart = s.charts.find((c) => c.id === id);
  if (!chart) throw new Error(`no chart ${id}`);
  return renderChart(chart, s);
};

describe('niceTicks', () => {
  it('steps from 0 past the max', () => {
    expect(niceTicks(1)).toEqual({ ticks: [0, 0.25, 0.5, 0.75, 1], decimals: 2 });
    expect(niceTicks(790)).toEqual({ ticks: [0, 200, 400, 600, 800], decimals: 0 });
    expect(niceTicks(841)).toEqual({ ticks: [0, 250, 500, 750, 1000], decimals: 0 });
    expect(niceTicks(0.0096)).toEqual({
      ticks: [0, 0.0025, 0.005, 0.0075, 0.01],
      decimals: 4,
    });
  });

  it('keeps counts whole', () => {
    expect(niceTicks(2, true)).toEqual({ ticks: [0, 1, 2], decimals: 0 });
    expect(niceTicks(0, true)).toEqual({ ticks: [0, 1], decimals: 0 });
  });
});

describe('renderChart', () => {
  it('draws a standalone SVG on its own background', () => {
    const out = svg('fix-rate');
    expect(out).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(out).toContain('fill="#fcfcfb"');
    expect(out).toContain('<title id="title">Fix rate</title>');
    expect(out.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('names each config in the legend and next to each bar', () => {
    const out = svg('fix-rate');
    expect(out).toContain(`fill="${seriesColor('tier1-only')}"`);
    expect(out).toContain('>tier1-only</text>');
    expect(out).toContain('0.50 (1/2)<tspan fill="#52514e">  tier1-only</tspan>');
    expect(out).toContain('1.00 (2/2)<tspan fill="#52514e">  ladder</tspan>');
    expect(out).toContain('fix rate (fixed runs / runs)');
  });

  it('labels a zero bar without drawing it', () => {
    const out = svg('false-escalations');
    expect(out).toContain('0 escalations in 2 runs');
    expect(out).not.toContain('false escalations: 0 escalations in 2 runs</title>');
  });

  it('marks p50 and p90 and shows n beside each strip', () => {
    const out = svg('time-to-page');
    expect(out).toContain('n=1, p50 841s, p90 841s');
    expect(out).toContain('n=0, p50 n/a, p90 n/a');
    expect(out).toContain('stroke-dasharray="3 2"');
    expect(out).toContain('<title>tier1-only: 841s</title>');
  });

  it('lists what the files left out', () => {
    const out = svg('fix-rate', set({ notes: ['ladder 2 scenarios skipped'] }));
    expect(out).toContain('Incomplete: ladder 2 scenarios skipped.');
  });

  it('escapes text', () => {
    expect(escapeXml('a<b & "c">')).toBe('a&lt;b &amp; &quot;c&quot;&gt;');
    expect(svg('fix-rate', set({ subtitle: 'x & y' }))).toContain('x &amp; y');
  });
});
