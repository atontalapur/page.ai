// Usage: node eval/scripts/record-frames.ts <image> [scenario-id...]
//        node eval/scripts/record-frames.ts <image> --replace <scenario-id...>
// Records meta.json frameLines for the named code scenarios (all of them by default): runs
// break.sh in a fresh sandbox and stores the text of each repo line the report's stack cites.
// Run it from the repo root right after capturing a report with trigger.sh.
//
// The lines come from the image, not the working tree, so rebuild it first:
//   docker build -f infra/sandbox/Dockerfile -t page-sandbox .
//
// A frame that fails the self-test's position checks (past the end, not on a token start)
// isn't recorded, since its report already points at the wrong code. An entry that exists and
// now reads differently means the same, so it fails unless --replace is given: recapture the
// report first, then replace. --replace needs the scenario ids, so it can't re-record every
// scenario at once.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listScenarioIds, loadScenario, problemsOf } from '../src/scenario.ts';
import {
  type ReportFrame,
  frameLinesScript,
  parseFrameLines,
  reportFrames,
} from '../src/selftest.ts';
import { withSandbox } from './sandbox.ts';

const SCENARIOS_DIR = 'scenarios';
const USAGE = [
  'usage: node eval/scripts/record-frames.ts <image> [scenario-id...]',
  '       node eval/scripts/record-frames.ts <image> --replace <scenario-id...>',
].join('\n');

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const [image, ...ids] = args.filter((arg) => arg !== '--replace');
if (!image || (replace && ids.length === 0)) {
  console.error(USAGE);
  process.exit(2);
}

function linesAfterBreak(dir: string, frames: ReportFrame[]): Promise<Record<string, string>> {
  return withSandbox(image!, async (sh) => {
    const broke = await sh(await readFile(join(dir, 'break.sh'), 'utf8'));
    if (broke.code !== 0) {
      throw new Error(`break.sh exited ${broke.code}\n${broke.output.trimEnd()}`);
    }
    const read = await sh(frameLinesScript(frames));
    if (read.code !== 0) throw new Error(read.output.trimEnd());
    return parseFrameLines(read.output);
  });
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
      console.log(`  recapture the report with trigger.sh, then rerun with --replace ${id}`);
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
    console.log(`FAIL ${id}\n  ${problemsOf(err).join('\n').replace(/\n/g, '\n  ')}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} scenario(s) failed`);
  process.exit(1);
}
