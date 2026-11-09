// Usage: node eval/scripts/selftest.ts [--concurrency N] <image> [scenario-id...]
// Self-tests the named scenarios (all of them by default). Run from the repo root. Exits 1
// if any scenario fails.
//
// A code scenario (Tier 1 and 2) runs against the sandbox image, each in a fresh
// container started the way the daemon starts one. An ops scenario (Tier 3) runs on the
// host against a live demo app, given by DEMO_APP_URL and OPS_SECRET (see
// scenarios/README.md). Without them, ops scenarios are skipped when no ids are named, and
// fail when they are, so CI can't pass by skipping them.
//
// --concurrency N (or SELFTEST_CONCURRENCY) runs up to N scenarios at once, 1 by default.
// Each sandbox gets 1 CPU, so leave the host a core. Ops scenarios still run one at a
// time, since they share the one live app. Results print in the order the ids were given.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runInOrder, serialized } from '../src/pool.ts';
import { listScenarioIds, loadScenario, problemsOf, type Scenario } from '../src/scenario.ts';
import { selfTest, selfTestOps } from '../src/selftest.ts';
import { hostShell, liveAppFromEnv } from './host.ts';
import { withSandbox } from './sandbox.ts';

const SCENARIOS_DIR = 'scenarios';
const NO_APP = 'needs a live demo app: set DEMO_APP_URL and OPS_SECRET';
const USAGE = 'usage: node eval/scripts/selftest.ts [--concurrency N] <image> [scenario-id...]';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { concurrency: { type: 'string' } },
});
const [image, ...ids] = positionals;
const concurrency = Number(values.concurrency ?? process.env.SELFTEST_CONCURRENCY ?? 1);
if (!image || !Number.isInteger(concurrency) || concurrency < 1) {
  console.error(USAGE);
  process.exit(2);
}
const app = liveAppFromEnv();
const oneOpsAtATime = serialized();

interface Outcome {
  status: 'pass' | 'fail' | 'skip';
  /** The scenario's whole report, printed in one piece. */
  lines: string[];
}

function crashed(id: string, err: unknown): Outcome {
  return { status: 'fail', lines: [`FAIL ${id}`, `  ${problemsOf(err).join('\n  ')}`] };
}

async function selfTestOne(id: string): Promise<Outcome> {
  let scenario: Scenario;
  try {
    scenario = await loadScenario(join(SCENARIOS_DIR, id));
  } catch (err) {
    return crashed(id, err);
  }

  if (scenario.kind === 'ops' && !app) {
    const status = ids.length > 0 ? 'fail' : 'skip';
    return { status, lines: [`${status.toUpperCase()} ${id}`, `  ${NO_APP}`] };
  }

  try {
    const result =
      scenario.kind === 'ops'
        ? await oneOpsAtATime(() => selfTestOps(scenario, hostShell(app!)))
        : await withSandbox(image!, (sh) => selfTest(scenario, sh));
    const lines = [`${result.passed ? 'PASS' : 'FAIL'} ${id}`];
    for (const step of result.steps) {
      lines.push(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.step}`);
      if (step.detail) lines.push(step.detail.replace(/^/gm, '       '));
    }
    return { status: result.passed ? 'pass' : 'fail', lines };
  } catch (err) {
    return crashed(id, err);
  }
}

let failed = 0;
let skipped = 0;
await runInOrder(
  ids.length > 0 ? ids : await listScenarioIds(SCENARIOS_DIR),
  concurrency,
  selfTestOne,
  ({ status, lines }) => {
    if (status === 'fail') failed++;
    if (status === 'skip') skipped++;
    console.log(lines.join('\n'));
  },
);

if (skipped > 0) console.log(`\n${skipped} ops scenario(s) skipped: ${NO_APP}`);
if (failed > 0) {
  console.log(`\n${failed} scenario(s) failed`);
  process.exit(1);
}
