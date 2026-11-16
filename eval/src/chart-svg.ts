// Draws chart-data.ts series as standalone SVG for docs/report. Each chart sits on its own
// light card with an explicit background, so it reads the same on GitHub's light and dark
// themes. Colors are the first three categorical slots of a palette checked for color
// vision deficiency; every bar and row is also labelled in text, so color never carries
// identity alone.
import type { Bar, BarChart, Chart, ChartSet, StripChart } from './chart-data.ts';
import { escapeXml } from '@page/contracts';
import { CONFIG_ORDER } from './report.ts';
import type { EvalConfig } from './results.ts';

const INK = {
  surface: '#fcfcfb',
  border: '#e1e0d9',
  primary: '#0b0b0b',
  secondary: '#52514e',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
};

/** By config, in report order, whatever configs a set holds. */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'] as const;

export function seriesColor(config: EvalConfig): string {
  return SERIES[CONFIG_ORDER.indexOf(config)] ?? INK.secondary;
}

const W = 760;
const PAD = 20;
const FONT = 'system-ui, -apple-system, &quot;Segoe UI&quot;, Helvetica, Arial, sans-serif';
/** Width of one character at 12px, on the wide side, for laying out text without measuring it. */
const CHAR = 7;

/** Estimated width of s at a font size, never narrower than it renders for these labels. */
export function textWidth(s: string, size = 12): number {
  return (s.length * CHAR * size) / 12;
}

const DASH = ' stroke-dasharray="3 2"';

const n = (v: number) => String(Math.round(v * 10) / 10);

function text(
  x: number,
  y: number,
  s: string,
  o: { size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: number } = {},
): string {
  const anchor = o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : '';
  const weight = o.weight ? ` font-weight="${o.weight}"` : '';
  return (
    `<text x="${n(x)}" y="${n(y)}" font-size="${o.size ?? 12}" fill="${o.fill ?? INK.primary}"` +
    `${anchor}${weight}>${escapeXml(s)}</text>`
  );
}

/**
 * Ticks from 0 at a step of 1, 2, 2.5 or 5 times a power of ten, no smaller than max / 4,
 * so at most 5 of them. Rounding the step up can leave 3, and whole counts below 2 get 2.
 */
export function niceTicks(max: number, integer = false): { ticks: number[]; decimals: number } {
  const top = max > 0 ? max : 1;
  const raw = top / 4;
  const k = Math.floor(Math.log10(raw));
  const base = 10 ** k;
  const steps = integer && k <= 0 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  const m = steps.find((s) => s * base >= raw - 1e-12) ?? 10;
  const step = Math.max(m * base, integer ? 1 : 0);
  const count = Math.ceil(top / step - 1e-9);
  const decimals = (String(Number(step.toFixed(10))).split('.')[1] ?? '').length;
  const ticks = Array.from({ length: count + 1 }, (_, i) => Number((i * step).toFixed(10)));
  return { ticks, decimals };
}

/**
 * Powers of ten from the one at or below min to the one at or above max, at least one decade
 * apart. Values under 0.1 count as 0.1.
 */
export function logTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(Math.max(min, 0.1)));
  const hi = Math.max(Math.ceil(Math.log10(Math.max(max, 0.1))), lo + 1);
  return Array.from({ length: hi - lo + 1 }, (_, i) => Number((10 ** (lo + i)).toPrecision(1)));
}

function wrap(s: string, width: number): string[] {
  const max = Math.floor(width / 6.2);
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface Frame {
  head: string[];
  /** y where the plot starts. */
  top: number;
}

interface LegendItem {
  /** Draws the key with its left edge at x, centered on y. */
  key: (x: number, y: number) => string;
  label: string;
}

const lineKey =
  (dash: string) =>
  (x: number, y: number): string =>
    `<line x1="${n(x + 6)}" y1="${n(y - 7)}" x2="${n(x + 6)}" y2="${n(y + 7)}" stroke="${INK.primary}" stroke-width="2"${dash}/>`;

/** Title, subtitle and a legend naming every config, plus any extra keys. */
function header(title: string, set: ChartSet, extra: LegendItem[]): Frame {
  const head = [
    text(PAD, PAD + 16, title, { size: 16, weight: 600 }),
    text(PAD, PAD + 36, set.subtitle, { fill: INK.secondary }),
  ];
  const y = PAD + 62;
  const items: LegendItem[] = [
    ...set.configs.map((c) => ({
      key: (x: number, cy: number) =>
        `<rect x="${n(x)}" y="${n(cy - 6)}" width="12" height="12" rx="2" fill="${seriesColor(c)}"/>`,
      label: c,
    })),
    ...extra,
  ];
  let x = PAD;
  for (const item of items) {
    head.push(item.key(x, y - 4), text(x + 18, y, item.label));
    x += 18 + item.label.length * CHAR + 18;
  }
  return { head, top: y + 22 };
}

function axis(
  ticks: number[],
  label: (v: number) => string,
  xOf: (v: number) => number,
  top: number,
  bottom: number,
  xLabel: string,
  mid: number,
): string[] {
  return [
    ...ticks.map(
      (t, i) =>
        `<line x1="${n(xOf(t))}" y1="${n(top)}" x2="${n(xOf(t))}" y2="${n(bottom)}" stroke="${i === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`,
    ),
    ...ticks.map((t) =>
      text(xOf(t), bottom + 16, label(t), { size: 11, fill: INK.secondary, anchor: 'middle' }),
    ),
    text(mid, bottom + 36, xLabel, { fill: INK.secondary, anchor: 'middle' }),
  ];
}

function finish(chart: Chart, set: ChartSet, body: string[], bottom: number): string {
  const notes =
    set.notes.length > 0 ? wrap(`Incomplete: ${set.notes.join('; ')}.`, W - 2 * PAD) : [];
  const noteY = bottom + 60;
  const lines = notes.map((l, i) =>
    text(PAD, noteY + i * 16, l, { size: 11, fill: INK.secondary }),
  );
  const h = Math.round((notes.length > 0 ? noteY + (notes.length - 1) * 16 : bottom + 40) + PAD);
  return [
    // Ids carry the chart id, so several charts inlined into one page don't share them.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="${chart.id}-title ${chart.id}-desc" font-family="${FONT}">`,
    `<title id="${chart.id}-title">${escapeXml(chart.title)}</title>`,
    `<desc id="${chart.id}-desc">${escapeXml(set.subtitle)}</desc>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="8" fill="${INK.surface}" stroke="${INK.border}"/>`,
    ...body,
    ...lines,
    '</svg>',
    '',
  ].join('\n');
}

/** A bar from the baseline, rounded only at its data end. */
function bar(x: number, y: number, w: number, h: number, fill: string, tip: string): string {
  const r = Math.min(4, w, h / 2);
  const d =
    w <= 0
      ? ''
      : `M${n(x)},${n(y)}h${n(w - r)}a${r},${r} 0 0 1 ${r},${r}v${n(h - 2 * r)}` +
        `a${r},${r} 0 0 1 ${-r},${r}h${n(r - w)}z`;
  return d ? `<path d="${d}" fill="${fill}"><title>${escapeXml(tip)}</title></path>` : '';
}

/** The text right of a bar: its label, then its config. */
const barText = (b: Bar) => `${b.label}  ${b.config}`;

/** Space between a bar's end and its text, and between a row label and the plot. */
const GAP = 6;
const LABEL_GAP = 12;

function renderBars(chart: BarChart, set: ChartSet): string {
  const { head, top } = header(chart.title, set, []);
  const { ticks, decimals } = niceTicks(chart.xMax, chart.xFormat === 'count');
  const max = ticks.at(-1) ?? 1;
  const fmt = (v: number) =>
    chart.xFormat === 'usd' ? `$${v.toFixed(decimals)}` : v.toFixed(decimals);

  // The plot spans whatever the labels leave: group labels on the left, and on the right the
  // last tick label and each bar's text past its end, so no text runs off the card.
  const left = PAD + Math.max(0, ...chart.groups.map((g) => textWidth(g.label))) + LABEL_GAP;
  const edge = W - PAD;
  let right = edge - textWidth(fmt(max), 11) / 2;
  for (const b of chart.groups.flatMap((g) => g.bars)) {
    const share = b.value / max;
    if (share > 0)
      right = Math.min(right, left + (edge - GAP - textWidth(barText(b)) - left) / share);
  }
  const xOf = (v: number) => left + (v / max) * (right - left);

  const barH = 16;
  const gap = 2;
  const groupGap = 18;
  const body: string[] = [];
  let y = top + 8;
  for (const g of chart.groups) {
    const gh = g.bars.length * barH + (g.bars.length - 1) * gap;
    body.push(text(left - LABEL_GAP, y + gh / 2 + 4, g.label, { anchor: 'end' }));
    g.bars.forEach((b, i) => {
      const by = y + i * (barH + gap);
      const tip = `${b.config}, ${g.label}: ${b.label}`;
      body.push(bar(left, by, xOf(b.value) - left, barH, seriesColor(b.config), tip));
      body.push(
        `<text x="${n(xOf(b.value) + GAP)}" y="${n(by + barH / 2 + 4)}" font-size="12" fill="${INK.primary}">` +
          `${escapeXml(b.label)}<tspan fill="${INK.secondary}">  ${escapeXml(b.config)}</tspan></text>`,
      );
    });
    y += gh + groupGap;
  }
  const bottom = y - groupGap + 8;
  return finish(
    chart,
    set,
    [...head, ...axis(ticks, fmt, xOf, top, bottom, chart.xLabel, (left + right) / 2), ...body],
    bottom,
  );
}

function renderStrip(chart: StripChart, set: ChartSet): string {
  const { head, top } = header(chart.title, set, [
    { key: lineKey(''), label: 'p50' },
    { key: lineKey(DASH), label: 'p90' },
  ]);
  const left = PAD + Math.max(0, ...chart.rows.map((r) => textWidth(r.config))) + LABEL_GAP;
  const right = W - PAD - Math.max(0, ...chart.rows.map((r) => textWidth(r.label))) - 16;
  // Log scale: times run from seconds to many minutes, and a linear axis sized to the
  // slowest run would squeeze every fast row into a few pixels.
  const all = chart.rows.flatMap((r) => r.sec);
  const ticks = all.length > 0 ? logTicks(Math.min(...all), Math.max(...all)) : logTicks(1, 10);
  const lo = Math.log10(ticks[0] ?? 1);
  const span = Math.log10(ticks.at(-1) ?? 10) - lo;
  const xOf = (v: number) =>
    left + ((Math.log10(Math.max(v, ticks[0] ?? 1)) - lo) / span) * (right - left);
  const minor = ticks.slice(0, -1).flatMap((t) => [2 * t, 5 * t]);

  const rowH = 40;
  const jitter = [-8, -4, 0, 4, 8];
  const body: string[] = [];
  chart.rows.forEach((r, i) => {
    const cy = top + 8 + i * rowH + rowH / 2;
    body.push(text(left - LABEL_GAP, cy + 4, r.config, { anchor: 'end' }));
    [...r.sec]
      .sort((a, b) => a - b)
      .forEach((s, j) => {
        body.push(
          `<circle cx="${n(xOf(s))}" cy="${n(cy + (jitter[j % jitter.length] ?? 0))}" r="4" fill="${seriesColor(r.config)}" fill-opacity="0.7" stroke="${INK.surface}" stroke-width="1"><title>${escapeXml(`${r.config}: ${Math.round(s)}s`)}</title></circle>`,
        );
      });
    for (const [p, dash] of [
      [r.p50, ''],
      [r.p90, DASH],
    ] as const) {
      if (p === null) continue;
      body.push(
        `<line x1="${n(xOf(p))}" y1="${n(cy - 17)}" x2="${n(xOf(p))}" y2="${n(cy + 17)}" stroke="${INK.primary}" stroke-width="2"${dash}/>`,
      );
    }
    body.push(text(right + 16, cy + 4, r.label));
  });
  const bottom = top + 8 + chart.rows.length * rowH + 4;
  return finish(
    chart,
    set,
    [
      ...head,
      ...minor.map(
        (t) =>
          `<line x1="${n(xOf(t))}" y1="${n(top)}" x2="${n(xOf(t))}" y2="${n(bottom)}" stroke="${INK.grid}" stroke-width="1"${DASH}/>`,
      ),
      ...axis(
        ticks,
        (v) => `${v}s`,
        xOf,
        top,
        bottom,
        `${chart.xLabel} (log scale), one dot per run`,
        (left + right) / 2,
      ),
      ...body,
    ],
    bottom,
  );
}

export function renderChart(chart: Chart, set: ChartSet): string {
  return chart.kind === 'bars' ? renderBars(chart, set) : renderStrip(chart, set);
}
