// Usage: node eval/scripts/record-frames.ts <image> [--replace] [scenario-id...]
// Records meta.json frameLines for the named code scenarios (all of them by default): runs
// break.sh in a fresh sandbox and stores the text of each repo line the report's stack cites.
// Run it from the repo root right after capturing a report with trigger.sh.
//
// An entry that exists and now reads differently means the cited line changed, so the report
// points at the wrong code. That fails unless --replace is given: recapture the report first,
// then replace.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listScenarioIds, loadScenario, ScenarioError } from '../src/scenario.ts';
import { type ReportFrame, frameLinesScript, reportFrames } from '../src/selftest.ts';
import { shellIn, startSandbox, stopSandbox } from './sandbox.ts';

const SCENARIOS_DIR = 'scenarios';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const [image, ...ids] = args.filter((arg) => arg !== '--replace');
if (!image) {
  console.error('usage: node eval/scripts/record-frames.ts <image> [--replace] [scenario-id...]');
  process.exit(2);
}

async function linesAfterBreak(
  dir: string,
  frames: ReportFrame[],
): Promise<Record<string, string>> {
  const name = startSandbox(image!);
  try {
    const sh = shellIn(name);
    const broke = await sh(await readFile(join(dir, 'break.sh'), 'utf8'));
    if (broke.code !== 0) {
      throw new Error(`break.sh exited ${broke.code}\n${broke.output.trimEnd()}`);
    }
    const read = await sh(frameLinesScript(frames));
    if (read.code !== 0) throw new Error(read.output.trimEnd());
    return JSON.parse(read.output) as Record<string, string>;
  } finally {
    stopSandbox(name);
  }
}

let failed = 0;
for (const id of ids.length > 0 ? ids : await listScenarioIds(SCENARIOS_DIR)) {
  const dir = join(SCENARIOS_DIR, id);
  try {
    const scenario = await loadScenario(dir);
    if (scenario.kind !== 'code') {
      console.log(`SKIP ${id}: ops scenario, the self-test doesn't check its frames`);
      continue;
    }
    const frames = reportFrames(scenario.meta.report);
    const lines = frames.length > 0 ? await linesAfterBreak(dir, frames) : {};
    const old = scenario.meta.frameLines ?? {};
    const changed = Object.keys(lines).filter(
      (key) => Object.hasOwn(old, key) && old[key] !== lines[key],
    );
    if (changed.length > 0 && !replace) {
      failed++;
      console.log(`FAIL ${id}`);
      console.log(`  changed since the report was captured: ${changed.join(', ')}`);
      console.log('  recapture the report with trigger.sh, then rerun with --replace');
      continue;
    }

    const path = join(dir, 'meta.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (frames.length > 0) raw.frameLines = lines;
    else delete raw.frameLines;
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    console.log(`ok   ${id}: ${Object.keys(lines).length} cited line(s)`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${id}`);
    const problems = err instanceof ScenarioError ? err.problems : [String(err)];
    console.log(`  ${problems.join('\n').replace(/\n/g, '\n  ')}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} scenario(s) failed`);
  process.exit(1);
}
