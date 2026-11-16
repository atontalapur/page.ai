// Usage: node eval/scripts/eval-charts.ts <results.json>... --out <dir>
// Writes the Results section charts as SVG files into <dir>, one results file per config.
// Same inputs and checks as eval-report.ts, so the charts match its tables.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chartData } from '../src/chart-data.ts';
import { renderChart } from '../src/chart-svg.ts';
import { loadResultsFile, ReportError } from '../src/report.ts';

const USAGE = 'usage: node eval/scripts/eval-charts.ts <results.json>... --out <dir>';

// A bad flag gets the usage line and exit 2, not a parseArgs stack trace.
let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
} catch {
  console.error(USAGE);
  process.exit(2);
}
const { values, positionals: paths } = parsed;
if (paths.length === 0 || !values.out) {
  console.error(USAGE);
  process.exit(2);
}
const out = values.out;

try {
  const set = chartData(await Promise.all(paths.map(loadResultsFile)));
  await mkdir(out, { recursive: true });
  for (const chart of set.charts) {
    const file = join(out, `${chart.id}.svg`);
    await writeFile(file, renderChart(chart, set));
    console.log(file);
  }
} catch (err) {
  if (!(err instanceof ReportError)) throw err;
  console.error(err.message);
  process.exit(1);
}
