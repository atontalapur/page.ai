// Usage: node eval/scripts/eval-report.ts <results.json>...
// Prints the Results section tables as markdown, one results file per config.
import { loadResultsFile, renderReport, ReportError } from '../src/report.ts';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: node eval/scripts/eval-report.ts <results.json>...');
  process.exit(2);
}

try {
  process.stdout.write(renderReport(await Promise.all(paths.map(loadResultsFile))));
} catch (err) {
  if (!(err instanceof ReportError)) throw err;
  console.error(err.message);
  process.exit(1);
}
