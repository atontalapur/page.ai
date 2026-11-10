// Usage: node eval/scripts/eval-tune.ts <results.json>...
// Prints per-tier tables for tuning the escalation threshold (#114) as markdown. Refuses,
// printing nothing, if any file names a scenario outside the dev set in eval/split.json.
import { fileURLToPath } from 'node:url';
import { loadResultsFile, ReportError } from '../src/report.ts';
import { loadSplit, splitIds } from '../src/split.ts';
import { assertDevOnly, renderTune } from '../src/tune.ts';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: node eval/scripts/eval-tune.ts <results.json>...');
  process.exit(2);
}

try {
  const split = await loadSplit(fileURLToPath(new URL('../split.json', import.meta.url)));
  const files = await Promise.all(
    paths.map(async (path) => ({ path, results: await loadResultsFile(path) })),
  );
  assertDevOnly(files, splitIds(split, 'dev'));
  process.stdout.write(renderTune(files.map((f) => f.results)));
} catch (err) {
  if (!(err instanceof ReportError)) throw err;
  console.error(err.message);
  process.exit(1);
}
