// Usage: OPENROUTER_API_KEY=... node eval/scripts/eval-run.ts <image> --config <name> [options] [id...]
// Plays scenarios under one configuration with a real model and writes the results JSON
// to eval/results/. Run from the repo root, after building the sandbox image.
import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { budgetFor, ESCALATION_THRESHOLD } from '@page/agent';
import { OpenRouterClient, withRetries } from '@page/model-client';
import {
  evalConfigSchema,
  EVAL_CONFIGS,
  loadResults,
  sameLimits,
  type EvalResults,
} from '../src/results.ts';
import { resultsFileName, runEval } from '../src/runner.ts';
import { listScenarioIds, loadScenario, ScenarioError, type Scenario } from '../src/scenario.ts';
import { loadSplit, splitIds } from '../src/split.ts';
import { dockerAttempt } from './attempt.ts';

const USAGE = `usage: OPENROUTER_API_KEY=... node eval/scripts/eval-run.ts <image> --config <${Object.keys(EVAL_CONFIGS).join('|')}>
  [--model <id>] [--runs <n>] [--max-cost <usd>] [--concurrency <n>] [--set dev|held-out]
  [--limit <n>] [--out <dir>] [--resume <results.json>] [id...]

  --model     OpenRouter model id (default: $OPENROUTER_MODEL)
  --runs      runs per scenario (default 1)
  --max-cost  total budget in USD; no attempt starts past it (default 1)
  --concurrency  scenario runs played at once (default 1); each attempt in flight holds
              its tier's cost limit (ESCALATION_THRESHOLD) of the budget, and a run can have a sandbox up per tier
  --set       only the dev or held-out scenarios from eval/split.json
  --limit     only the first n scenarios
  --out       results directory (default eval/results)
  --resume    an unfinished results file: keeps its runs and spend, plays the rest, and
              rewrites that file. --config, --model and --runs default to its values and
              must match them; the commit must match too. --max-cost is the total,
              its spend included.

The results file is rewritten after every run. Ctrl-C pauses: attempts in flight stop,
the file is written, and --resume <file> picks up later. A second Ctrl-C quits at once.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    model: { type: 'string' },
    runs: { type: 'string' },
    'max-cost': { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '1' },
    set: { type: 'string' },
    limit: { type: 'string' },
    out: { type: 'string', default: 'eval/results' },
    resume: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const [image, ...named] = positionals;
let resume: EvalResults | undefined;
if (values.resume !== undefined) {
  try {
    resume = await loadResults(values.resume);
  } catch (err) {
    fail(`--resume ${values.resume}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const apiKey = process.env.OPENROUTER_API_KEY;
const model = values.model ?? resume?.model ?? process.env.OPENROUTER_MODEL;
const config = evalConfigSchema.safeParse(values.config ?? resume?.config);
const runs = Number(values.runs ?? resume?.runsPerScenario ?? 1);
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
if (resume !== undefined) {
  const mismatch = (
    [
      ['--config', resume.config, config.data],
      ['--model', resume.model, model],
      ['--runs', resume.runsPerScenario, runs],
      ['commit', resume.gitSha, gitSha],
    ] as const
  ).filter(([, was, now]) => was !== now);
  // Catches an uncommitted threshold.ts edit, which the commit can't show. Files from
  // before #114 don't record limits; their commit check covers it.
  if (resume.limits !== undefined && !sameLimits(resume.limits, ESCALATION_THRESHOLD)) {
    fail(
      `--resume ${values.resume} played at other limits than threshold.ts has now: ` +
        `${JSON.stringify(resume.limits)}. Restore those limits to resume it.`,
    );
  }
  if (mismatch.length > 0) {
    const what = mismatch.map(([name, was, now]) => `${name} was ${was}, now ${now}`).join('; ');
    const hint = mismatch.some(([name]) => name === 'commit')
      ? ` Check out ${resume.gitSha} to resume it.`
      : '';
    fail(`--resume ${values.resume} doesn't match this run: ${what}.${hint}`);
  }
  const ids = new Set(scenarios.map((sc) => sc.id));
  const missing = [...new Set(resume.runs.map((r) => r.scenario))].filter((id) => !ids.has(id));
  if (missing.length > 0) {
    fail(`--resume ${values.resume} has runs for scenarios not picked now: ${missing.join(', ')}`);
  }
  if (resume.spentUsd >= maxCost) {
    fail(
      `--resume ${values.resume} already spent $${resume.spentUsd.toFixed(4)}; raise --max-cost`,
    );
  }
}
const client = withRetries(new OpenRouterClient({ apiKey, model }));
console.log(
  `${config.data}: ${scenarios.length} scenarios x ${runs} runs, ${model}, budget $${maxCost}, ` +
    `up to ${concurrency} at a time`,
);
// Every attempt in flight holds its tier's cost limit (the escalation threshold's). The
// warnings below assume the dearest tier this config plays.
const ATTEMPT_COST_LIMIT_USD = Math.max(
  ...EVAL_CONFIGS[config.data].map((tier) => budgetFor(tier).costLimitUsd),
);
const funded = Math.floor(maxCost / ATTEMPT_COST_LIMIT_USD);
if (concurrency > 1 && funded < concurrency) {
  console.warn(
    `warning: --max-cost $${maxCost} holds only ${Math.max(funded, 1)} attempt(s) of ` +
      `$${ATTEMPT_COST_LIMIT_USD.toFixed(2)} at once, so fewer than ${concurrency} agents will run ` +
      `together. Pass --max-cost ${concurrency * ATTEMPT_COST_LIMIT_USD} or more for that.`,
  );
}
// Each attempt in flight holds its full limit, so once a paid model spends past the slack,
// a run waits for money. A model that spends nothing keeps the concurrency.
const slack = maxCost - concurrency * ATTEMPT_COST_LIMIT_USD;
if (concurrency > 1 && funded >= concurrency && slack < ATTEMPT_COST_LIMIT_USD) {
  console.warn(
    `warning: --max-cost $${maxCost} leaves $${slack.toFixed(2)} beyond ${concurrency} attempts of ` +
      `$${ATTEMPT_COST_LIMIT_USD.toFixed(2)}; once more than that is spent, fewer than ` +
      `${concurrency} agents run together.`,
  );
}

await mkdir(values.out, { recursive: true });
const path = values.resume ?? '';
let out = path;
// Written whole, then renamed over the file, so a kill mid-write can't leave half a file.
const save = (r: EvalResults) => {
  out ||= join(values.out, resultsFileName(r));
  writeFileSync(`${out}.tmp`, `${JSON.stringify(r, null, 2)}\n`);
  renameSync(`${out}.tmp`, out);
};

const pause = new AbortController();
process.on('SIGINT', () => {
  if (pause.signal.aborted) process.exit(130);
  console.log('pausing: stopping the attempts in flight (Ctrl-C again to quit at once)');
  pause.abort();
});

if (resume !== undefined) {
  console.log(
    `resuming ${values.resume}: ${resume.runs.length} runs kept, ` +
      `$${resume.spentUsd.toFixed(4)} spent; playing the rest`,
  );
}

const results = await runEval({
  config: config.data,
  scenarios,
  runsPerScenario: runs,
  maxCostUsd: maxCost,
  attemptCostLimitUsd: (tier) => budgetFor(tier).costLimitUsd,
  concurrency,
  model,
  gitSha,
  limits: ESCALATION_THRESHOLD,
  attempt: dockerAttempt(image, client),
  ...(resume === undefined ? {} : { resume }),
  signal: pause.signal,
  onCheckpoint: save,
  onRun: (r) => {
    const tiers = r.attempts.map((a) => `T${a.tier} ${a.exitStatus}`).join(' -> ');
    const verdict = r.fixed ? 'fixed' : r.paged ? 'paged' : 'not fixed';
    console.log(`  ${r.scenario} #${r.run}: ${verdict} (${tiers}), $${r.costUsd.toFixed(4)}`);
  },
});

save(results);

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
if (pause.signal.aborted) {
  console.log(`paused; resume with: pnpm eval:run ${image} --resume ${out} [same --set or ids]`);
}
console.log(`results: ${out}`);
