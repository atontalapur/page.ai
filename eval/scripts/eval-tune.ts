// Usage: node eval/scripts/eval-tune.ts <results.json>...
// Prints per-tier tables for tuning the escalation threshold (#114) as markdown. Refuses,
// printing nothing, if any file names a scenario outside the dev set in eval/split.json.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ESCALATION_THRESHOLD, type TierBudget } from '@page/agent';
import { loadResultsFile, ReportError } from '../src/report.ts';
import { sameLimits, type EvalResults } from '../src/results.ts';
import { loadSplit, splitIds } from '../src/split.ts';
import { assertDevOnly, renderTune } from '../src/tune.ts';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: node eval/scripts/eval-tune.ts <results.json>...');
  process.exit(2);
}

const THRESHOLD_FILE = 'packages/agent/src/threshold.ts';
// git runs at the repo root: a pathspec resolves from the cwd, so from eval/ the diff below
// would match nothing and always look unchanged.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Before threshold.ts (#114), every tier ran on DEFAULT_AGENT_CONFIG's limits, unchanged
// since the agent landed in #57.
const BEFORE_THRESHOLD: TierBudget = {
  stepLimit: 40,
  costLimitUsd: 0.5,
  wallTimeLimitMs: 14 * 60 * 1000,
};

const git = (args: string[]) => {
  try {
    execFileSync('git', ['-C', ROOT, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/**
 * Why a file's runs may have had other limits than this checkout's, uncommitted edits
 * included, or undefined if they had the same. Files from eval:run since #114 record the
 * limits they played at; older ones are judged by their commit.
 */
function limitsDiffer({ limits, gitSha: sha }: EvalResults): string | undefined {
  if (limits !== undefined) {
    return sameLimits(limits, ESCALATION_THRESHOLD)
      ? undefined
      : `recorded limits ${JSON.stringify(limits)}`;
  }
  if (!git(['cat-file', '-e', `${sha}^{commit}`])) return 'is not a commit in this checkout';
  if (git(['cat-file', '-e', `${sha}:${THRESHOLD_FILE}`])) {
    return git(['diff', '--quiet', sha, '--', THRESHOLD_FILE])
      ? undefined
      : `has a different ${THRESHOLD_FILE}`;
  }
  const same = Object.values(ESCALATION_THRESHOLD).every((budget) =>
    (Object.keys(BEFORE_THRESHOLD) as (keyof TierBudget)[]).every(
      (k) => budget[k] === BEFORE_THRESHOLD[k],
    ),
  );
  return same ? undefined : 'predates the threshold, when every tier had 40 calls, $0.50, 14 min';
}

try {
  const split = await loadSplit(fileURLToPath(new URL('../split.json', import.meta.url)));
  const files = await Promise.all(
    paths.map(async (path) => ({ path, results: await loadResultsFile(path) })),
  );
  // The same run passed twice (a copy, a symlink, a checkpoint and its resume) would count
  // every attempt twice. A run is its config, model and start time.
  const seen = new Map<string, string>();
  for (const { path, results } of files) {
    const run = `${results.config}|${results.model}|${results.startedAt}`;
    const first = seen.get(run);
    if (first !== undefined) throw new ReportError(`${path}: the same run as ${first}`);
    seen.set(run, path);
  }
  assertDevOnly(files, splitIds(split, 'dev'));
  // The what-if tables trust that the runs were cut at today's limits.
  for (const { path, results } of files) {
    const why = limitsDiffer(results);
    if (why === undefined) continue;
    console.warn(
      `warning: ${path} (${results.gitSha.slice(0, 7)}) ${why}; the tables compare against ` +
        "today's limits, which those runs may not have used.",
    );
  }
  process.stdout.write(renderTune(files.map((f) => f.results)));
} catch (err) {
  if (!(err instanceof ReportError)) throw err;
  console.error(err.message);
  process.exit(1);
}
