// Usage: node eval/scripts/selftest.ts <image> [scenario-id...]
// Self-tests the named scenarios (all of them by default). Run from the repo root. Exits 1
// if any scenario fails.
//
// A code scenario (Tier 1 and 2) runs against the sandbox image, each in a fresh
// container started the way the daemon starts one. An ops scenario (Tier 3) runs on the
// host against a live demo app, given by DEMO_APP_URL and OPS_SECRET (see
// scenarios/README.md). Without them, ops scenarios are skipped when no ids are named, and
// fail when they are, so CI can't pass by skipping them.
import { join } from 'node:path';
import { listScenarioIds, loadScenario, type Scenario, ScenarioError } from '../src/scenario.ts';
import { type SelfTestResult, selfTest, selfTestOps } from '../src/selftest.ts';
import { hostShell, liveAppFromEnv } from './host.ts';
import { shellIn, startSandbox, stopSandbox } from './sandbox.ts';

const SCENARIOS_DIR = 'scenarios';
const NO_APP = 'needs a live demo app: set DEMO_APP_URL and OPS_SECRET';

const [image, ...ids] = process.argv.slice(2);
if (!image) {
  console.error('usage: node eval/scripts/selftest.ts <image> [scenario-id...]');
  process.exit(2);
}
const app = liveAppFromEnv();

async function inSandbox(scenario: Scenario): Promise<SelfTestResult> {
  let name: string | undefined;
  try {
    name = startSandbox(image!);
    return await selfTest(scenario, shellIn(name));
  } finally {
    if (name) stopSandbox(name);
  }
}

let failed = 0;
let skipped = 0;
for (const id of ids.length > 0 ? ids : await listScenarioIds(SCENARIOS_DIR)) {
  let scenario;
  try {
    scenario = await loadScenario(join(SCENARIOS_DIR, id));
  } catch (err) {
    failed++;
    console.log(`FAIL ${id}`);
    console.log(
      err instanceof ScenarioError ? `  ${err.problems.join('\n  ')}` : `  ${String(err)}`,
    );
    continue;
  }

  if (scenario.kind === 'ops' && !app) {
    if (ids.length > 0) failed++;
    else skipped++;
    console.log(`${ids.length > 0 ? 'FAIL' : 'SKIP'} ${id}\n  ${NO_APP}`);
    continue;
  }

  try {
    const result =
      scenario.kind === 'ops'
        ? await selfTestOps(scenario, hostShell(app!))
        : await inSandbox(scenario);
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${id}`);
    for (const step of result.steps) {
      console.log(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.step}`);
      if (step.detail) console.log(step.detail.replace(/^/gm, '       '));
    }
    if (!result.passed) failed++;
  } catch (err) {
    failed++;
    console.log(`FAIL ${id}`);
    console.log(`  ${String(err)}`);
  }
}

if (skipped > 0) console.log(`\n${skipped} ops scenario(s) skipped: ${NO_APP}`);
if (failed > 0) {
  console.log(`\n${failed} scenario(s) failed`);
  process.exit(1);
}
