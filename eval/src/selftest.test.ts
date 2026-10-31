import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scenario } from './scenario.ts';
import { NO_CHECK_IN_SANDBOX, type SandboxShell, selfTest } from './selftest.ts';

let scenario: Scenario;
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'selftest-'));
  await writeFile(join(dir, 'break.sh'), 'BREAK');
  await writeFile(join(dir, 'check.sh'), 'CHECK');
  await writeFile(join(dir, 'reference_fix.patch'), '--- a/x\n+++ b/x\n');
  scenario = {
    id: '001-sample',
    dir,
    meta: { class: 'backend-api', expectedTier: 1, description: 'Sample' },
  };
});
afterEach(async () => {
  await rm(scenario.dir, { recursive: true, force: true });
});

/**
 * A fake sandbox: one bit of state (broken or not) that break.sh sets and the patch
 * clears. `fixes` says whether the patch actually fixes the bug.
 */
function fakeSandbox({ fixes = true, breaks = true } = {}): {
  sh: SandboxShell;
  scripts: string[];
} {
  let broken = false;
  const scripts: string[] = [];
  const sh: SandboxShell = (script) => {
    scripts.push(script);
    if (script === 'BREAK') broken = breaks;
    else if (script.startsWith('git apply')) broken = broken && !fixes;
    else if (script === 'CHECK') {
      return Promise.resolve({ code: broken ? 1 : 0, output: broken ? 'FAIL cart.test.ts' : 'ok' });
    }
    return Promise.resolve({ code: 0, output: '' });
  };
  return { sh, scripts };
}

describe('selfTest', () => {
  it('passes when check passes, then fails after break, then passes after the fix', async () => {
    const { sh, scripts } = fakeSandbox();
    const result = await selfTest(scenario, sh);
    expect(result.passed).toBe(true);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(scripts).toEqual([
      NO_CHECK_IN_SANDBOX,
      'CHECK',
      'BREAK',
      'CHECK',
      expect.stringContaining('+++ b/x\nPAGE_PATCH_EOF\n'),
      'CHECK',
      NO_CHECK_IN_SANDBOX,
    ]);
  });

  it('fails when the reference fix does not fix the bug', async () => {
    const result = await selfTest(scenario, fakeSandbox({ fixes: false }).sh);
    expect(result.passed).toBe(false);
    expect(result.steps.at(-1)).toEqual({
      step: 'check passes after the fix',
      ok: false,
      detail: 'expected exit 0, got 1\nFAIL cart.test.ts',
    });
  });

  it('fails when break.sh does not break anything', async () => {
    const result = await selfTest(scenario, fakeSandbox({ breaks: false }).sh);
    expect(result.passed).toBe(false);
    const last = result.steps.at(-1);
    expect(last?.step).toBe('check fails after break.sh');
    expect(last?.detail).toMatch(/^expected a non-zero exit, got 0/);
  });

  it('stops at the first failing step and keeps only the tail of its output', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const scripts: string[] = [];
    const result = await selfTest(scenario, (script) => {
      scripts.push(script);
      return Promise.resolve({ code: 3, output: lines });
    });
    expect(scripts).toHaveLength(1);
    const detail = result.steps[0]?.detail?.split('\n') ?? [];
    expect(detail[0]).toBe('expected exit 0, got 3');
    expect(detail.slice(1)).toHaveLength(40);
    expect(detail.at(-1)).toBe('line 99');
  });
});
