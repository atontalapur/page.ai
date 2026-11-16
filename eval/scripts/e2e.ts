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
  parseDuration,
  parseTimeouts,
  runE2E,
  summarize,
  type E2EOptions,
  type E2EResult,
  type Target,
} from '../src/e2e.ts';
import { OrchestratorControl, PgPipelineReader, realClock } from '../src/e2e-adapters.ts';
import { loadScenario, ScenarioError, type Scenario } from '../src/scenario.ts';
import { loadSplit } from '../src/split.ts';
import { localTarget, stagingTarget } from './e2e-targets.ts';

const USAGE = `usage: pnpm e2e <scenario-id> [--target local|staging] [--expect pr|approval]
  [--timeout <step>=<duration>]... [--budget <duration>] [--poll <duration>]
  [--runs <n>] [--keep] [--no-build] [--out <file.json>]

  --target   local (default): a demo app on this machine, staging: the app at DEMO_APP_URL
  --expect   what the run ends on (default: pr for a Tier 2 code scenario, else approval)
  --timeout  a step's limit, e.g. --timeout fix=20m (steps: seed trigger issue triage
             claim fix outcome reset)
  --budget   most time from the trigger to the PR or approval request (default 20m)
  --poll     between database reads (default 3s)
  --runs     play it n times in a row, stopping at the first failure (default 1)
  --keep     skip the reset, to look at the PR and the issue afterwards
  --no-build local: use the page-sandbox:demo image already built
  --out      write the results as JSON

Env: E2E_DATABASE_URL (or DATABASE_URL), E2E_ORCHESTRATOR_URL (or ORCHESTRATOR_URL),
GITHUB_TOKEN and GITHUB_REPO, DEMO_APP_URL (staging, and local ops scenarios), OPS_SECRET
(ops scenarios), PGBOSS_SCHEMA, and for the local demo app POSTHOG_KEY, POSTHOG_HOST,
E2E_DEMO_APP_PORT, E2E_DEMO_DATABASE_URL.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: 'string', default: 'local' },
    expect: { type: 'string' },
    timeout: { type: 'string', multiple: true, default: [] },
    budget: { type: 'string' },
    poll: { type: 'string' },
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
if (values.expect !== undefined && values.expect !== 'pr' && values.expect !== 'approval') {
  fail(`--expect must be pr or approval, not ${values.expect}`);
}
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a positive integer');

const options: E2EOptions = {
  timeouts: parsed('--timeout', () => parseTimeouts(values.timeout)),
  keep: values.keep,
};
if (values.expect !== undefined) options.expect = values.expect;
if (values.budget !== undefined) {
  options.budgetMs = parsed('--budget', () => parseDuration(values.budget!));
}
if (values.poll !== undefined) options.pollMs = parsed('--poll', () => parseDuration(values.poll!));

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
if (databaseUrl === undefined) fail("E2E_DATABASE_URL (the orchestrator's database) is not set");
if (orchestratorUrl === undefined) fail('E2E_ORCHESTRATOR_URL is not set');

const token = env('GITHUB_TOKEN');
const repo = env('GITHUB_REPO');
const github = token && repo ? new RestGitHub({ token, repo }) : undefined;

const opsSecret = env('OPS_SECRET');
const demoAppUrl = env('DEMO_APP_URL')?.replace(/\/+$/, '');
let target: Target;
if (values.target === 'staging') {
  if (demoAppUrl === undefined) fail('--target staging needs DEMO_APP_URL');
  target = stagingTarget({ url: demoAppUrl, opsSecret });
} else {
  const port = Number(env('E2E_DEMO_APP_PORT') ?? '3100');
  if (!Number.isInteger(port) || port < 1) fail('E2E_DEMO_APP_PORT must be a port number');
  const pgPort = env('POSTGRES_PORT') ?? '5432';
  target = localTarget({
    port,
    databaseUrl:
      env('E2E_DEMO_DATABASE_URL') ?? `postgres://page:page@host.docker.internal:${pgPort}/demo`,
    opsApp: { url: demoAppUrl ?? 'http://localhost:3000', opsSecret },
    build: !values['no-build'],
  });
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
    `target       ${target.name}${values.target === 'staging' ? ` ${demoAppUrl}` : ''}`,
    `database     ${dbHost}`,
    `orchestrator ${orchestratorUrl}`,
    `github       ${github === undefined ? 'none (no PR lookup or close)' : repo}`,
  ].join('\n'),
);

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, query_timeout: 15_000 });
const pgbossSchema = env('PGBOSS_SCHEMA');
const reader = new PgPipelineReader(pool, pgbossSchema === undefined ? {} : { pgbossSchema });
const control = new OrchestratorControl(orchestratorUrl);

const results: E2EResult[] = [];
try {
  for (let n = 1; n <= runs; n += 1) {
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
  await writeFile(values.out, `${JSON.stringify(runs === 1 ? results[0] : results, null, 2)}\n`);
  console.log(`\nwrote ${values.out}`);
}
const passed = results.filter((r) => r.passed).length;
if (runs > 1) console.log(`\n${passed} of ${runs} runs passed in a row`);
process.exit(passed === runs ? 0 : 1);
