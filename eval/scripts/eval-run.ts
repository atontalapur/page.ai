// Usage: OPENROUTER_API_KEY=... node eval/scripts/eval-run.ts <image> --config <name> [options] [id...]
// Plays scenarios under one configuration with a real model and writes the results JSON
// to eval/results/. Run from the repo root, after building the sandbox image.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenRouterClient, withRetries } from '@page/model-client';
import { evalConfigSchema, EVAL_CONFIGS } from '../src/results.ts';
import { resultsFileName, runEval } from '../src/runner.ts';
import { listScenarioIds, loadScenario, ScenarioError, type Scenario } from '../src/scenario.ts';
import { loadSplit, splitIds } from '../src/split.ts';
import { dockerAttempt } from './attempt.ts';

/** The most one attempt may spend; every attempt in flight holds this much of the budget. */
const ATTEMPT_COST_LIMIT_USD = 0.5;

const USAGE = `usage: OPENROUTER_API_KEY=... node eval/scripts/eval-run.ts <image> --config <${Object.keys(EVAL_CONFIGS).join('|')}>
  [--model <id>] [--runs <n>] [--max-cost <usd>] [--concurrency <n>] [--set dev|held-out]
  [--limit <n>] [--out <dir>] [id...]

  --model     OpenRouter model id (default: $OPENROUTER_MODEL)
  --runs      runs per scenario (default 1)
  --max-cost  total budget in USD; no attempt starts past it (default 1)
  --concurrency  scenario runs played at once (default 1); each attempt in flight holds
              $0.50 of the budget, and a run can have a sandbox up per tier
  --set       only the dev or held-out scenarios from eval/split.json
  --limit     only the first n scenarios
  --out       results directory (default eval/results)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    model: { type: 'string' },
    runs: { type: 'string', default: '1' },
    'max-cost': { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '1' },
    set: { type: 'string' },
    limit: { type: 'string' },
    out: { type: 'string', default: 'eval/results' },
  },
});

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const [image, ...named] = positionals;
const apiKey = process.env.OPENROUTER_API_KEY;
const model = values.model ?? process.env.OPENROUTER_MODEL;
const config = evalConfigSchema.safeParse(values.config);
const runs = Number(values.runs);
const maxCost = Number(values['max-cost']);
const concurrency = Number(values.concurrency);
const limit = values.limit === undefined ? Infinity : Number(values.limit);
if (!image) fail('missing <image>');
if (!apiKey) fail('OPENROUTER_API_KEY is not set');
if (!model) fail('no model: pass --model or set OPENROUTER_MODEL');
if (!config.success) fail(`unknown --config ${values.config}`);
if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a positive integer');
if (!(maxCost > 0)) fail('--max-cost must be a positive number');
if (!Number.isInteger(concurrency) || concurrency < 1) {
  fail('--concurrency must be a positive integer');
}
if (limit !== Infinity && !(Number.isInteger(limit) && limit > 0)) {
  fail('--limit must be a positive integer');
}
if (values.set !== undefined && values.set !== 'dev' && values.set !== 'held-out') {
  fail('--set must be dev or held-out');
}

let ids = named.length > 0 ? named : await listScenarioIds('scenarios');
if (values.set !== undefined) {
  const inSet = new Set(splitIds(await loadSplit('eval/split.json'), values.set));
  ids = ids.filter((id) => inSet.has(id));
}
ids = ids.slice(0, limit);

const scenarios: Scenario[] = [];
for (const id of ids) {
  try {
    scenarios.push(await loadScenario(join('scenarios', id)));
  } catch (err) {
    if (err instanceof ScenarioError) fail(err.message);
    throw err;
  }
}

const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const client = withRetries(new OpenRouterClient({ apiKey, model }));
console.log(
  `${config.data}: ${scenarios.length} scenarios x ${runs} runs, ${model}, budget $${maxCost}, ` +
    `up to ${concurrency} at a time`,
);
const funded = Math.floor(maxCost / ATTEMPT_COST_LIMIT_USD);
if (concurrency > 1 && funded < concurrency) {
  console.warn(
    `warning: --max-cost $${maxCost} holds only ${Math.max(funded, 1)} attempt(s) of ` +
      `$${ATTEMPT_COST_LIMIT_USD.toFixed(2)} at once, so fewer than ${concurrency} agents will run ` +
      `together. Pass --max-cost ${concurrency * ATTEMPT_COST_LIMIT_USD} or more for that.`,
  );
}

const results = await runEval({
  config: config.data,
  scenarios,
  runsPerScenario: runs,
  maxCostUsd: maxCost,
  attemptCostLimitUsd: ATTEMPT_COST_LIMIT_USD,
  concurrency,
  model,
  gitSha,
  attempt: dockerAttempt(image, client),
  onRun: (r) => {
    const tiers = r.attempts.map((a) => `T${a.tier} ${a.exitStatus}`).join(' -> ');
    const verdict = r.fixed ? 'fixed' : r.paged ? 'paged' : 'not fixed';
    console.log(`  ${r.scenario} #${r.run}: ${verdict} (${tiers}), $${r.costUsd.toFixed(4)}`);
  },
});

await mkdir(values.out, { recursive: true });
const path = join(values.out, resultsFileName(results));
await writeFile(path, `${JSON.stringify(results, null, 2)}\n`);

const s = results.summary;
for (const skip of results.skipped) console.log(`  ${skip.scenario}: skipped, ${skip.reason}`);
for (const e of results.errors)
  console.log(`  ${e.scenario} #${e.run} T${e.tier}: error, ${e.message}`);
if (results.stoppedForBudget) {
  console.log(`budget of $${maxCost} reached; runs it cut short or never started are left out`);
}
if (results.stoppedForProvider) {
  console.log(
    'model provider failed (see the errors); runs it cut short or never started are left ' +
      'out. Rerun them, and the runs in errors, later.',
  );
}
if (results.notPlayed.length > 0) {
  const list = results.notPlayed.map((r) => `${r.scenario} #${r.run}`).join(', ');
  console.log(`not played (notPlayed): ${list}`);
}
console.log(
  `fixed ${s.fixed}/${s.runs} (${(s.fixRate * 100).toFixed(0)}%), $${s.costUsd.toFixed(4)}, ` +
    `${s.blockedSteps}/${s.steps} steps blocked, ${s.falseEscalations} false escalations, ${s.falsePages} false pages`,
);
console.log(`results: ${path}`);
