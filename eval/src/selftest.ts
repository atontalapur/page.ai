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

// Lines of output kept for a failed step.
const TAIL_LINES = 40;

/**
 * The #6 self-test: on a clean demo app check.sh passes, after break.sh it fails, and
 * after reference_fix.patch it passes again. Stops at the first step that goes wrong.
 */
export async function selfTest(scenario: Scenario, sh: SandboxShell): Promise<SelfTestResult> {
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

  const plan: { step: string; script: string; expect: 'pass' | 'fail' }[] = [
    { step: 'check.sh is not in the sandbox', script: NO_CHECK_IN_SANDBOX, expect: 'pass' },
    { step: 'check passes on the clean app', script: check, expect: 'pass' },
    { step: 'break.sh runs', script: breakScript, expect: 'pass' },
    { step: 'check fails after break.sh', script: check, expect: 'fail' },
    { step: 'reference_fix.patch applies', script: apply, expect: 'pass' },
    { step: 'check passes after the fix', script: check, expect: 'pass' },
    { step: 'check.sh is still not in the sandbox', script: NO_CHECK_IN_SANDBOX, expect: 'pass' },
  ];

  const steps: StepResult[] = [];
  for (const { step, script, expect } of plan) {
    const { code, output } = await sh(script);
    const ok = expect === 'pass' ? code === 0 : code !== 0;
    if (ok) {
      steps.push({ step, ok });
      continue;
    }
    const wanted = expect === 'pass' ? 'exit 0' : 'a non-zero exit';
    steps.push({ step, ok, detail: `expected ${wanted}, got ${code}\n${tail(output)}` });
    return { id: scenario.id, passed: false, steps };
  }
  return { id: scenario.id, passed: true, steps };
}

function tail(output: string): string {
  return output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
}
