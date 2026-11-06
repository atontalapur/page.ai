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

/**
 * The #6 self-test: on a clean demo app check.sh passes, after break.sh it fails, and
 * after reference_fix.patch it passes again. Stops at the first step that goes wrong.
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

  const plan: PlanStep[] = [
    { step: 'check.sh is not in the sandbox', script: NO_CHECK_IN_SANDBOX, expect: 'pass' },
    { step: 'check passes on the clean app', script: check, expect: 'pass' },
    { step: 'break.sh runs', script: breakScript, expect: 'pass' },
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
