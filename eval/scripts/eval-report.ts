// Usage: node eval/scripts/eval-report.ts <results.json>...
// Prints the Results section tables as markdown, one results file per config.
import { loadResults } from '../src/results.ts';
import { renderReport, ReportError } from '../src/report.ts';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: node eval/scripts/eval-report.ts <results.json>...');
  process.exit(2);
}

async function load(path: string) {
  try {
    return await loadResults(path);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new ReportError(`${path}: ${why}`);
  }
}

try {
  process.stdout.write(renderReport(await Promise.all(paths.map(load))));
} catch (err) {
  if (!(err instanceof ReportError)) throw err;
  console.error(err.message);
  process.exit(1);
}
