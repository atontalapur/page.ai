// Usage: node eval/scripts/selftest.ts <image> [scenario-id...]
// Self-tests the named scenarios (all of them by default) against a sandbox image, each
// in a fresh container started the way the daemon starts one. Run from the repo root.
// Exits 1 if any scenario fails.
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { listScenarioIds, loadScenario, ScenarioError } from '../src/scenario.ts';
import { type ExecResult, type SandboxShell, selfTest } from '../src/selftest.ts';

const SCENARIOS_DIR = 'scenarios';

const [image, ...ids] = process.argv.slice(2);
if (!image) {
  console.error('usage: node eval/scripts/selftest.ts <image> [scenario-id...]');
  process.exit(2);
}

function startSandbox(): string {
  return execFileSync('node', ['apps/node/scripts/sandbox-run.ts', image!], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function shellIn(name: string): SandboxShell {
  return (script) =>
    new Promise<ExecResult>((resolve, reject) => {
      const child = spawn('docker', ['exec', '-i', '-w', '/workspace', name, 'sh', '-s'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, output }));
      child.stdin.end(script);
    });
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

  const name = startSandbox();
  try {
    const result = await selfTest(scenario, shellIn(name));
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${id}`);
    for (const step of result.steps) {
      console.log(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.step}`);
      if (step.detail) console.log(step.detail.replace(/^/gm, '       '));
    }
    if (!result.passed) failed++;
  } finally {
    execFileSync('docker', ['stop', '-t', '1', name], { stdio: 'ignore' });
  }
}

if (failed > 0) {
  console.log(`\n${failed} scenario(s) failed`);
  process.exit(1);
}
