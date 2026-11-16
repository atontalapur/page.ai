import { describe, expect, it } from 'vitest';
import { chartData, type BarChart, type ChartSet } from './chart-data.ts';
import {
  escapeXml,
  logTicks,
  niceTicks,
  renderChart,
  seriesColor,
  textWidth,
} from './chart-svg.ts';
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

describe('logTicks', () => {
  it('spans whole decades around the values', () => {
    expect(logTicks(7, 841)).toEqual([1, 10, 100, 1000]);
    expect(logTicks(10, 100)).toEqual([10, 100]);
    expect(logTicks(150, 380)).toEqual([100, 1000]);
    expect(logTicks(0, 0.5)).toEqual([0.1, 1]);
  });
});

/** Where each text element starts and ends, from its x, anchor and estimated width. */
function textSpans(out: string): { text: string; start: number; end: number }[] {
  return [
    ...out.matchAll(/<text x="([\d.-]+)"[^>]*?(?: text-anchor="(\w+)")?[^>]*>(.*?)<\/text>/g),
  ].map(([, x, anchor, inner]) => {
    const t = (inner ?? '').replace(/<[^>]+>/g, '').replaceAll('&amp;', '&');
    const w = textWidth(t);
    const start = Number(x) - (anchor === 'end' ? w : anchor === 'middle' ? w / 2 : 0);
    return { text: t, start, end: start + w };
  });
}

describe('renderChart', () => {
  it('draws a standalone SVG on its own background', () => {
    const out = svg('fix-rate');
    expect(out).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(out).toContain('fill="#fcfcfb"');
    expect(out).toContain('<title id="fix-rate-title">Fix rate</title>');
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

  it('gives each chart its own title and desc ids', () => {
    const out = svg('time-to-fix');
    expect(out).toContain('aria-labelledby="time-to-fix-title time-to-fix-desc"');
    expect(out).toContain('<desc id="time-to-fix-desc">');
  });

  it('draws times on a log axis labelled in seconds', () => {
    const out = svg('time-to-page');
    expect(out).toContain('>100s</text>');
    expect(out).toContain('>1000s</text>');
    expect(out).toContain('seconds from the exception to the page (log scale), one dot per run');
  });

  it('keeps long labels on the card, beside the longest bar too', () => {
    const base = set();
    const chart: BarChart = {
      kind: 'bars',
      id: 'long',
      title: 'Long',
      xLabel: 'count',
      xMax: 10,
      xFormat: 'count',
      groups: [
        {
          label: 'a group label far longer than any in the report',
          bars: [
            {
              config: 'tier1-only',
              value: 10,
              label: 'a bar label that is long as well, 10 of 10',
            },
            { config: 'ladder', value: 3, label: '3' },
          ],
        },
      ],
    };
    const out = renderChart(chart, { ...base, charts: [chart] });
    const spans = textSpans(out);
    expect(spans.map((s) => s.text)).toContain(
      'a bar label that is long as well, 10 of 10  tier1-only',
    );
    for (const s of spans) {
      expect(s.start, s.text).toBeGreaterThanOrEqual(20);
      expect(s.end, s.text).toBeLessThanOrEqual(740);
    }
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
