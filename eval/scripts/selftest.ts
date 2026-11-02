// Usage: node eval/scripts/selftest.ts <image> [scenario-id...]
// Self-tests the named scenarios (all of them by default) against a sandbox image, each
// in a fresh container started the way the daemon starts one. Run from the repo root.
// Exits 1 if any scenario fails.
import { join } from 'node:path';
import { listScenarioIds, loadScenario, ScenarioError } from '../src/scenario.ts';
import { selfTest } from '../src/selftest.ts';
import { shellIn, startSandbox, stopSandbox } from './sandbox.ts';

const SCENARIOS_DIR = 'scenarios';

const [image, ...ids] = process.argv.slice(2);
if (!image) {
  console.error('usage: node eval/scripts/selftest.ts <image> [scenario-id...]');
  process.exit(2);
}

let failed = 0;
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

  let name: string | undefined;
  try {
    name = startSandbox(image);
    const result = await selfTest(scenario, shellIn(name));
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
  } finally {
    if (name) stopSandbox(name);
  }
}

if (failed > 0) {
  console.log(`\n${failed} scenario(s) failed`);
  process.exit(1);
}
