// Draws chart-data.ts series as standalone SVG for docs/report. Each chart sits on its own
// light card with an explicit background, so it reads the same on GitHub's light and dark
// themes. Colors are the first three categorical slots of a palette checked for color
// vision deficiency; every bar and row is also labelled in text, so color never carries
// identity alone.
import type { BarChart, Chart, ChartSet, StripChart } from './chart-data.ts';
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
/** Rough width of one character at 12px, for laying out text without measuring it. */
const CHAR = 7;

export function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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

/** Ticks from 0 at a step of 1, 2, 2.5 or 5 times a power of ten, 4 or 5 of them. */
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
      (t) =>
        `<line x1="${n(xOf(t))}" y1="${n(top)}" x2="${n(xOf(t))}" y2="${n(bottom)}" stroke="${t === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`,
    ),
    ...ticks.map((t) =>
      text(xOf(t), bottom + 16, label(t), { size: 11, fill: INK.secondary, anchor: 'middle' }),
    ),
    text(mid, bottom + 36, xLabel, { fill: INK.secondary, anchor: 'middle' }),
  ];
}

function finish(title: string, set: ChartSet, body: string[], bottom: number): string {
  const notes =
    set.notes.length > 0 ? wrap(`Incomplete: ${set.notes.join('; ')}.`, W - 2 * PAD) : [];
  const noteY = bottom + 60;
  const lines = notes.map((l, i) =>
    text(PAD, noteY + i * 16, l, { size: 11, fill: INK.secondary }),
  );
  const h = Math.round((notes.length > 0 ? noteY + (notes.length - 1) * 16 : bottom + 40) + PAD);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="title desc" font-family="${FONT}">`,
    `<title id="title">${escapeXml(title)}</title>`,
    `<desc id="desc">${escapeXml(set.subtitle)}</desc>`,
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

function renderBars(chart: BarChart, set: ChartSet): string {
  const { head, top } = header(chart.title, set, []);
  const left = PAD + 130;
  const right = W - PAD - 210;
  const { ticks, decimals } = niceTicks(chart.xMax, chart.xFormat === 'count');
  const max = ticks.at(-1) ?? 1;
  const xOf = (v: number) => left + (v / max) * (right - left);
  const fmt = (v: number) =>
    chart.xFormat === 'usd' ? `$${v.toFixed(decimals)}` : v.toFixed(decimals);

  const barH = 16;
  const gap = 2;
  const groupGap = 18;
  const body: string[] = [];
  let y = top + 8;
  for (const g of chart.groups) {
    const gh = g.bars.length * barH + (g.bars.length - 1) * gap;
    body.push(text(left - 12, y + gh / 2 + 4, g.label, { anchor: 'end' }));
    g.bars.forEach((b, i) => {
      const by = y + i * (barH + gap);
      const tip = `${b.config}, ${g.label}: ${b.label}`;
      body.push(bar(left, by, xOf(b.value) - left, barH, seriesColor(b.config), tip));
      body.push(
        `<text x="${n(xOf(b.value) + 6)}" y="${n(by + barH / 2 + 4)}" font-size="12" fill="${INK.primary}">` +
          `${escapeXml(b.label)}<tspan fill="${INK.secondary}">  ${escapeXml(b.config)}</tspan></text>`,
      );
    });
    y += gh + groupGap;
  }
  const bottom = y - groupGap + 8;
  return finish(
    chart.title,
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
  const left = PAD + 110;
  const right = W - PAD - 200;
  const all = chart.rows.flatMap((r) => r.sec);
  const { ticks, decimals } = niceTicks(Math.max(1, ...all));
  const max = ticks.at(-1) ?? 1;
  const xOf = (v: number) => left + (v / max) * (right - left);

  const rowH = 40;
  const jitter = [-8, -4, 0, 4, 8];
  const body: string[] = [];
  chart.rows.forEach((r, i) => {
    const cy = top + 8 + i * rowH + rowH / 2;
    body.push(text(left - 12, cy + 4, r.config, { anchor: 'end' }));
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
    chart.title,
    set,
    [
      ...head,
      ...axis(
        ticks,
        (v) => v.toFixed(decimals),
        xOf,
        top,
        bottom,
        `${chart.xLabel}, one dot per run`,
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
