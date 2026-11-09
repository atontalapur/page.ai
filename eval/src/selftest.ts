import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scenario } from './scenario.ts';

export interface ExecResult {
  code: number;
  output: string;
}

/**
 * Runs a shell script inside a sandbox container, fed over stdin (`sh -s` in /workspace).
 * Scenario files never get copied into the container, so the agent can't read check.sh.
 */
export type SandboxShell = (script: string) => Promise<ExecResult>;

/**
 * Runs one of an ops scenario's scripts on the host, from its file (so it can source the
 * shared helpers next to it), against the live demo app at $DEMO_APP_URL.
 */
export type HostShell = (script: string) => Promise<ExecResult>;

export interface StepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface SelfTestResult {
  id: string;
  passed: boolean;
  steps: StepResult[];
}

// The sandbox image bakes in only the demo app, so neither the scenarios directory nor
// any check.sh should exist in it. Checked before and after the run.
export const NO_CHECK_IN_SANDBOX = `
test ! -e /workspace/scenarios || { echo "/workspace/scenarios exists"; exit 1; }
found="$(find /workspace -name node_modules -prune -o -name check.sh -print)"
test -z "$found" || { echo "check.sh in sandbox: $found"; exit 1; }
`;

// check.sh exits with this while the bug is there. Any other non-zero code (125-127 from
// docker exec, 137 from the OOM killer) means the check or the sandbox broke instead.
export const BUG_PRESENT = 1;

// Lines of output kept for a failed step.
const TAIL_LINES = 40;

export interface ReportFrame {
  path: string;
  line: number;
  column: number;
}

const STACK_LINE = /^[ \t]*at .*$/gm;
// A repo-relative path with its line and column. The lookbehind skips the same names inside
// node_modules or an absolute path. Parentheses stay in the path for Next.js route groups.
const FRAME = /(?<![\w./@-])((?:apps|packages)\/[^\s:]+):(\d+):(\d+)/g;
// Not source: these change without anyone editing the repo.
const GENERATED = /(?:^|[\s(/])(?:node_modules|\.next)\//;
// Anything that looks like a repo file with a line number.
const REPO_LOCATION = /(?:apps|packages|src)\/[^\s:]*:\d+/;

function stackLines(report: string): string[] {
  return (report.match(STACK_LINE) ?? []).map((line) => line.trim());
}

/** The stack frames in a report that point into this repo, without repeats. */
export function reportFrames(report: string): ReportFrame[] {
  const frames = new Map<string, ReportFrame>();
  for (const text of stackLines(report)) {
    for (const [frame, path, line, column] of text.matchAll(FRAME)) {
      if (GENERATED.test(path!)) continue;
      frames.set(frame, { path: path!, line: Number(line), column: Number(column) });
    }
  }
  return [...frames.values()];
}

/**
 * Stack lines that cite a repo file in a form `reportFrames` can't check, such as
 * `/workspace/apps/...`, `./apps/...` or a frame with no column. Reports give repo-relative
 * `path:line:column`, so these fail instead of going unchecked.
 */
export function uncheckedFrames(report: string): string[] {
  return stackLines(report).filter(
    (line) => REPO_LOCATION.test(line) && !GENERATED.test(line) && line.match(FRAME) === null,
  );
}

// The scripts below run as `node -` in the sandbox. `locate` finds where a frame lands:
// `source` is the text of its line when the line exists, and `problem` says why the frame
// doesn't fit. Node counts columns in UTF-16 code units, as V8 does, and a frame must land
// on the start of a token.
const LOCATE = String.raw`const { readFileSync } = require('node:fs');
function locate({ path, line, column }) {
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) {
    return { problem: 'lines and columns are whole numbers from 1' };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { problem: error.code === 'ENOENT' ? 'no such file' : "can't read: " + error.code };
  }
  // V8 ends a line at these too, but source maps may not, so a frame's line is ambiguous.
  if (/\r(?!\n)|[\u2028\u2029]/.test(text)) {
    return { problem: 'the file has a lone CR, U+2028 or U+2029, which tools number differently' };
  }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const source = lines[line - 1]?.replace(/\r$/, '');
  if (source === undefined) return { problem: 'past the end of the file' };
  if (column > source.length) return { source, problem: 'past the end of the line' };
  const [before, here] = [source[column - 2] ?? '', source[column - 1]];
  if (/\s/.test(here) || (/[\w$]/.test(here) && /[\w$]/.test(before))) {
    return { source, problem: 'not the start of a token in ' + JSON.stringify(source.trim()) };
  }
  return { source };
}
`;

// Each cited line must also read as meta.json frameLines recorded it, so a line that moved
// inside its file fails (#79).
const FRAME_CHECK = String.raw`const problems = [];
const cited = new Set();
for (const frame of input.frames) {
  const { at, key } = frame;
  cited.add(key);
  const { source, problem } = locate(frame);
  if (source !== undefined && !Object.hasOwn(input.lines, key)) {
    problems.push(at + ': not in meta.json frameLines; run pnpm scenarios:frames');
  } else if (source !== undefined && input.lines[key] !== source) {
    problems.push(
      at + ': the line changed since the report was captured, from ' +
        JSON.stringify(input.lines[key]) + ' to ' + JSON.stringify(source),
    );
  } else if (problem) {
    problems.push(at + ': ' + problem);
  }
}
for (const key of Object.keys(input.lines)) {
  if (!cited.has(key)) problems.push(key + ': in meta.json frameLines, but no frame cites it');
}
for (const line of input.unchecked) {
  problems.push(line + ': not a repo-relative path:line:column frame');
}
if (problems.length > 0) {
  console.log(problems.join('\n'));
  process.exitCode = 1;
}
`;

// Prints the cited lines after FRAME_LINES_MARKER, or exits 1 if a frame doesn't fit.
const FRAME_LINES_MARKER = 'PAGE_FRAME_LINES ';
const FRAME_LINES = String.raw`const found = {};
const problems = [];
for (const frame of input.frames) {
  const { source, problem } = locate(frame);
  if (problem) problems.push(frame.at + ': ' + problem);
  else found[frame.key] = source;
}
if (problems.length > 0) {
  console.log(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log(input.marker + JSON.stringify(found));
}
`;

/** The `meta.json` frameLines key for a frame. */
export function frameLineKey(frame: ReportFrame): string {
  return `${frame.path}:${frame.line}`;
}

function nodeScript(input: object, body: string): string {
  // Quoted heredoc, so nothing is expanded. The delimiter can't be a line of its own here:
  // the input is one line of JSON after `const input =`.
  return `node - <<'PAGE_FRAMES_EOF'\nconst input = ${JSON.stringify(input)};\n${LOCATE}${body}PAGE_FRAMES_EOF\n`;
}

function frameInput(frames: ReportFrame[]) {
  return frames.map((frame) => ({
    ...frame,
    at: `${frame.path}:${frame.line}:${frame.column}`,
    key: frameLineKey(frame),
  }));
}

/**
 * A script that exits 1 if a frame's file is gone, its line or column is past the end, or its
 * column isn't the start of a token; if a cited line has no `lines` entry (meta.json
 * frameLines) or reads differently; if an entry has no frame; and for any stack line in
 * `unchecked`.
 */
export function framesExistScript(
  frames: ReportFrame[],
  unchecked: string[],
  lines: Record<string, string>,
): string {
  return nodeScript({ frames: frameInput(frames), unchecked, lines }, FRAME_CHECK);
}

/**
 * A script that prints each frame's line keyed by `frameLineKey` (read it with
 * `parseFrameLines`), and exits 1 if a frame fails the same position checks as
 * `framesExistScript`.
 */
export function frameLinesScript(frames: ReportFrame[]): string {
  return nodeScript({ frames: frameInput(frames), marker: FRAME_LINES_MARKER }, FRAME_LINES);
}

/**
 * The lines from `frameLinesScript`'s output. The sandbox shell mixes stderr into the
 * output, so a Node warning can sit next to them; only the marked line is read.
 */
export function parseFrameLines(output: string): Record<string, string> {
  const line = output.split('\n').find((l) => l.startsWith(FRAME_LINES_MARKER));
  if (line === undefined) throw new Error(`no frame lines in the output:\n${output.trimEnd()}`);
  return JSON.parse(line.slice(FRAME_LINES_MARKER.length)) as Record<string, string>;
}

/**
 * The #6 self-test: on a clean demo app check.sh passes, after break.sh it fails, and
 * after reference_fix.patch it passes again. Stops at the first step that goes wrong.
 * The report's stack frames must also fit the code break.sh leaves behind (#74, #79).
 */
export async function selfTest(scenario: Scenario, sh: SandboxShell): Promise<SelfTestResult> {
  if (scenario.kind !== 'code') throw new Error(`${scenario.id} is an ${scenario.kind} scenario`);
  const read = (file: string) => readFile(join(scenario.dir, file), 'utf8');
  const [breakScript, check, patch] = await Promise.all([
    read('break.sh'),
    read('check.sh'),
    read('reference_fix.patch'),
  ]);
  // Quoted heredoc, so git apply gets the patch byte for byte. The delimiter can't
  // appear in a patch line, which always starts with a space, +, - or a header.
  const body = patch.endsWith('\n') ? patch : `${patch}\n`;
  const apply = `git apply --whitespace=nowarn - <<'PAGE_PATCH_EOF'\n${body}PAGE_PATCH_EOF\n`;
  const { report } = scenario.meta;
  // Every cited line must be recorded, so a scenario without frameLines fails here.
  const frames = framesExistScript(
    reportFrames(report),
    uncheckedFrames(report),
    scenario.meta.frameLines ?? {},
  );

  const plan: PlanStep[] = [
    { step: 'check.sh is not in the sandbox', script: NO_CHECK_IN_SANDBOX, expect: 'pass' },
    { step: 'check passes on the clean app', script: check, expect: 'pass' },
    { step: 'break.sh runs', script: breakScript, expect: 'pass' },
    { step: 'report frames exist after break.sh', script: frames, expect: 'pass' },
    { step: 'check fails after break.sh', script: check, expect: 'fail' },
    { step: 'reference_fix.patch applies', script: apply, expect: 'pass' },
    { step: 'check passes after the fix', script: check, expect: 'pass' },
    { step: 'check.sh is still not in the sandbox', script: NO_CHECK_IN_SANDBOX, expect: 'pass' },
  ];

  const steps: StepResult[] = [];
  const passed = await runPlan(plan, sh, steps);
  return { id: scenario.id, passed, steps };
}

/**
 * The self-test for an ops scenario (Tier 3), run against a live demo app: check.sh
 * passes on the clean app, fails after break-ops.sh plants the bug, and passes after
 * fix-ops.sh undoes it with an ops action (an override deleted, a rollback) and waits
 * for the app to come back. Every script runs on the host from its file.
 *
 * The app is shared, so a run that fails after break-ops.sh still runs fix-ops.sh, to
 * leave the app clean for the next scenario. That cleanup is reported as its own step.
 */
export async function selfTestOps(scenario: Scenario, run: HostShell): Promise<SelfTestResult> {
  if (scenario.kind !== 'ops') throw new Error(`${scenario.id} is a ${scenario.kind} scenario`);
  const path = (file: string) => join(scenario.dir, file);
  const check = path('check.sh');
  const fix = path('fix-ops.sh');

  const plan: PlanStep[] = [
    { step: 'check passes on the clean app', script: check, expect: 'pass' },
    { step: 'break-ops.sh runs', script: path('break-ops.sh'), expect: 'pass' },
    { step: 'check fails after break-ops.sh', script: check, expect: 'fail' },
    { step: 'fix-ops.sh runs', script: fix, expect: 'pass' },
    { step: 'check passes after fix-ops.sh', script: check, expect: 'pass' },
  ];

  const steps: StepResult[] = [];
  if (await runPlan(plan, run, steps)) return { id: scenario.id, passed: true, steps };

  // break-ops.sh may have changed the app even if it failed, so clean up whenever it ran,
  // unless fix-ops.sh itself already ran to the end.
  const broke = steps.some((s) => s.step === 'break-ops.sh runs');
  const fixed = steps.some((s) => s.step === 'fix-ops.sh runs' && s.ok);
  if (broke && !fixed) {
    await runPlan([{ step: 'cleanup: fix-ops.sh runs', script: fix, expect: 'pass' }], run, steps);
  }
  return { id: scenario.id, passed: false, steps };
}

interface PlanStep {
  step: string;
  script: string;
  expect: 'pass' | 'fail';
}

/** Runs the plan in order into `steps`. Stops at the first step that goes wrong. */
async function runPlan(
  plan: PlanStep[],
  sh: (script: string) => Promise<ExecResult>,
  steps: StepResult[],
): Promise<boolean> {
  for (const { step, script, expect } of plan) {
    const { code, output } = await sh(script);
    const ok = code === (expect === 'pass' ? 0 : BUG_PRESENT);
    if (ok) {
      steps.push({ step, ok });
      continue;
    }
    const wanted = `exit ${expect === 'pass' ? 0 : BUG_PRESENT}`;
    steps.push({ step, ok, detail: `expected ${wanted}, got ${code}\n${tail(output)}` });
    return false;
  }
  return true;
}

function tail(output: string): string {
  return output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
}
