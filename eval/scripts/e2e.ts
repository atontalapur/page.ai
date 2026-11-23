// Usage: pnpm e2e <scenario-id> [--target local|staging] [options]
// The end-to-end test of the live pipeline (#14): seeds the scenario's bug, fires it, and
// waits for the webhook, triage, the fix run, and the PR or approval request, then resets.
// Run from the repo root. `pnpm e2e` loads .env if there is one. See eval/README.md.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RestGitHub } from '@page/toolkit';
import pg from 'pg';
import {
  defaultExpectation,
  formatMs,
  parseDrain,
  parseDuration,
  parseTimeouts,
  prepareTarget,
  runE2E,
  stepTimeouts,
  summarize,
  type E2EOptions,
  type E2EReport,
  type E2EResult,
  type Target,
} from '../src/e2e.ts';
import { OrchestratorControl, PgPipelineReader, realClock } from '../src/e2e-adapters.ts';
import { localAppUrl } from '../src/e2e-app.ts';
import { loadScenario, ScenarioError, type Scenario } from '../src/scenario.ts';
import { loadSplit } from '../src/split.ts';
import { localTarget, stagingTarget } from './e2e-targets.ts';

const USAGE = `usage: pnpm e2e <scenario-id> [--target local|staging]
  [--expect pr|approval|resolved] [--timeout <step>=<duration>]... [--budget <duration>]
  [--poll <duration>] [--drain <duration>] [--runs <n>] [--keep] [--no-build]
  [--out <file.json>]

  --target   local (default): a demo app on this machine, staging: the app at DEMO_APP_URL
  --expect   what the run ends on (default: pr for a Tier 2 code scenario, resolved for an
             ops scenario, else approval)
  --timeout  a step's limit, e.g. --timeout fix=20m (steps: seed trigger issue triage
             claim fix outcome reset)
  --budget   most time from the trigger to the PR or approval request (default: the
             sum of the trigger to outcome step limits, 32m at Tier 1, 48m at Tier 2)
  --poll     between database reads (default 3s)
  --drain    after the reset's kill, how long to watch a run a daemon is still on for a
             late PR to close (default: what is left of its 16m per tier; 0 skips it)
  --runs     play it n times in a row, stopping at the first failure (default 1)
  --keep     skip the reset, to look at the PR and the issue afterwards (one run only)
  --no-build local: use the page-sandbox:demo image already built, instead of building
             it once before the first run
  --out      write the results as JSON: { prepare, runs }

Env: E2E_DATABASE_URL (or DATABASE_URL), E2E_ORCHESTRATOR_URL (or ORCHESTRATOR_URL),
E2E_ORCHESTRATOR_API_TOKEN (or ORCHESTRATOR_API_TOKEN), GITHUB_TOKEN and GITHUB_REPO, DEMO_APP_URL (staging only), E2E_LOCAL_APP_URL (local ops
scenarios, default http://localhost:\${DEMO_APP_PORT:-3000}), OPS_SECRET (ops scenarios),
PGBOSS_SCHEMA, and for local code scenarios POSTHOG_KEY, POSTHOG_HOST, E2E_DEMO_APP_PORT,
E2E_DEMO_DATABASE_URL.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: 'string', default: 'local' },
    expect: { type: 'string' },
    timeout: { type: 'string', multiple: true, default: [] },
    budget: { type: 'string' },
    poll: { type: 'string' },
    drain: { type: 'string' },
    runs: { type: 'string', default: '1' },
    keep: { type: 'boolean', default: false },
    'no-build': { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parsed<T>(flag: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    fail(`${flag}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

const [id, ...extra] = positionals;
if (id === undefined) fail('missing <scenario-id>');
if (extra.length > 0) fail(`one scenario at a time, not ${positionals.join(' ')}`);
if (values.target !== 'local' && values.target !== 'staging') {
  fail(`--target must be local or staging, not ${values.target}`);
}
if (
  values.expect !== undefined &&
  values.expect !== 'pr' &&
  values.expect !== 'approval' &&
  values.expect !== 'resolved'
) {
  fail(`--expect must be pr, approval or resolved, not ${values.expect}`);
}
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a positive integer');
if (values.keep && runs > 1) {
  fail(
    `--keep can't be used with --runs ${runs}: without the reset, run 2 finds run 1's ` +
      'issue still open and fails',
  );
}

const options: E2EOptions = {
  timeouts: parsed('--timeout', () => parseTimeouts(values.timeout)),
  keep: values.keep,
};
if (values.expect !== undefined) options.expect = values.expect;
if (values.budget !== undefined) {
  options.budgetMs = parsed('--budget', () => parseDuration(values.budget!));
}
if (values.poll !== undefined) options.pollMs = parsed('--poll', () => parseDuration(values.poll!));
if (values.drain !== undefined) {
  options.drainMs = parsed('--drain', () => parseDrain(values.drain!));
}

let scenario: Scenario;
try {
  scenario = await loadScenario(join('scenarios', id));
} catch (err) {
  fail(err instanceof ScenarioError ? err.message : `scenario ${id}: ${String(err)}`);
}
// Like demo-sync.sh: a held-out bug run now is spent before the held-out eval (#114).
if (!(await loadSplit('eval/split.json')).dev.includes(id)) {
  fail(`${id} is not a dev bug in eval/split.json (held out or unlisted); pick a dev bug`);
}

const databaseUrl = env('E2E_DATABASE_URL') ?? env('DATABASE_URL');
const orchestratorUrl = env('E2E_ORCHESTRATOR_URL') ?? env('ORCHESTRATOR_URL');
const apiToken = env('E2E_ORCHESTRATOR_API_TOKEN') ?? env('ORCHESTRATOR_API_TOKEN');
if (databaseUrl === undefined) fail("E2E_DATABASE_URL (the orchestrator's database) is not set");
if (orchestratorUrl === undefined) fail('E2E_ORCHESTRATOR_URL is not set');
// Checked before seeding: without it the reset's kill gets a 401 and leaves the issue open.
if (apiToken === undefined)
  fail("E2E_ORCHESTRATOR_API_TOKEN (the orchestrator's API token) is not set");

const token = env('GITHUB_TOKEN');
const repo = env('GITHUB_REPO');
const github =
  token && repo ? parsed('GITHUB_REPO', () => new RestGitHub({ token, repo })) : undefined;
if (github === undefined && (options.expect ?? defaultExpectation(scenario)) === 'pr') {
  fail(`expecting a PR from ${id} needs GITHUB_TOKEN and GITHUB_REPO`);
}

const opsSecret = env('OPS_SECRET');
const seedLimit = stepTimeouts(scenario, options.timeouts).seed;
let target: Target;
// The app the scenario's scripts run against, for the header.
let appUrl: string;
if (values.target === 'staging') {
  const demoAppUrl = env('DEMO_APP_URL')?.replace(/\/+$/, '');
  if (demoAppUrl === undefined) fail('--target staging needs DEMO_APP_URL');
  target = stagingTarget({ url: demoAppUrl, opsSecret });
  appUrl = demoAppUrl;
} else {
  // Never DEMO_APP_URL, which is staging's: a local ops scenario breaks the compose app.
  const opsAppUrl = parsed('--target local', () => localAppUrl(process.env));
  const port = Number(env('E2E_DEMO_APP_PORT') ?? '3100');
  if (!Number.isInteger(port) || port < 1) fail('E2E_DEMO_APP_PORT must be a port number');
  if (scenario.kind === 'code' && env('POSTHOG_KEY') === undefined) {
    fail(
      `--target local with code scenario ${id} needs POSTHOG_KEY: without it the demo app ` +
        'keeps its errors in memory, so no issue can open',
    );
  }
  const pgPort = env('POSTGRES_PORT') ?? '5432';
  target = localTarget({
    port,
    databaseUrl:
      env('E2E_DEMO_DATABASE_URL') ?? `postgres://page:page@host.docker.internal:${pgPort}/demo`,
    opsApp: { url: opsAppUrl, opsSecret },
    build: !values['no-build'],
    buildTimeoutMs: seedLimit,
  });
  appUrl = scenario.kind === 'ops' ? opsAppUrl : `http://localhost:${port}`;
}

// Only the host: the URL carries the password.
const dbHost = (() => {
  try {
    return new URL(databaseUrl).host;
  } catch {
    fail('E2E_DATABASE_URL is not a URL');
  }
})();
console.log(
  [
    `scenario     ${scenario.id} (${scenario.kind}, tier ${scenario.meta.expectedTier})`,
    `target       ${target.name}`,
    `app          ${appUrl}`,
    `database     ${dbHost}`,
    `orchestrator ${orchestratorUrl}`,
    `github       ${github === undefined ? 'none (no PR lookup or close)' : repo}`,
  ].join('\n'),
);

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, query_timeout: 15_000 });
// An idle connection the server or network drops is an 'error' on the pool, which would
// crash the process before the reset. The pool has already dropped that client, so the
// next query opens a new one. Logs the host only: the URL carries the password.
pool.on('error', (error) => {
  const message = error.message.replaceAll(databaseUrl, dbHost);
  console.error(
    `database ${dbHost}: idle connection lost (${message}); reconnecting on the next read`,
  );
});
const pgbossSchema = env('PGBOSS_SCHEMA');
let reader: PgPipelineReader;
try {
  reader = new PgPipelineReader(pool, pgbossSchema === undefined ? {} : { pgbossSchema });
} catch (error) {
  // A bad schema name is a bad argument (exit 2), and the pool goes first.
  await pool.end();
  fail(error instanceof Error ? error.message : String(error));
}
const control = new OrchestratorControl(orchestratorUrl, apiToken);

// Once, before the first run and outside its seed step, so every run's seed time compares.
// It resolves with a record whatever happens.
const prepared = await prepareTarget(scenario, target, {
  clock: realClock,
  timeoutMs: seedLimit,
  log: (line) => console.log(line),
});

const results: E2EResult[] = [];
try {
  for (let n = 1; prepared?.ok !== false && n <= runs; n += 1) {
    if (runs > 1) console.log(`\nrun ${n} of ${runs}`);
    const result = await runE2E(
      scenario,
      {
        target,
        reader,
        control,
        ...(github === undefined ? {} : { github }),
        clock: realClock,
        log: (line) => console.log(line),
      },
      options,
    );
    results.push(result);
    console.log(`\n${summarize(result)}`);
    if (!result.passed) break;
  }
} finally {
  await pool.end();
}

if (values.out !== undefined) {
  const report: E2EReport = { v: 1, prepare: prepared, runs: results };
  await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${values.out}`);
}
if (prepared?.ok === false) console.log(`\nFAIL ${scenario.id}: preparing ${target.name} failed`);
const passed = results.filter((r) => r.passed).length;
if (runs > 1) {
  const before = prepared === null ? '' : `, after ${formatMs(prepared.durationMs)} preparing`;
  console.log(`\n${passed} of ${runs} runs passed in a row${before}`);
}
process.exit(passed === runs ? 0 : 1);
