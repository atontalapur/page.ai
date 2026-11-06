import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scenario } from './scenario.ts';
import {
  type HostShell,
  NO_CHECK_IN_SANDBOX,
  type SandboxShell,
  selfTest,
  selfTestOps,
} from './selftest.ts';

let scenario: Scenario;
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'selftest-'));
  await writeFile(join(dir, 'break.sh'), 'BREAK');
  await writeFile(join(dir, 'check.sh'), 'CHECK');
  await writeFile(join(dir, 'reference_fix.patch'), '--- a/x\n+++ b/x\n');
  scenario = {
    id: '001-sample',
    kind: 'code',
    dir,
    meta: {
      class: 'backend-api',
      expectedTier: 1,
      description: 'Sample',
      report: 'GET / returned 500',
    },
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
    expect(last?.detail).toMatch(/^expected exit 1, got 0/);
  });

  it('fails when check.sh dies for a reason other than the bug', async () => {
    const { sh } = fakeSandbox();
    let checks = 0;
    const result = await selfTest(scenario, (script) => {
      // The second check (after break.sh) gets OOM-killed instead of reporting the bug.
      if (script === 'CHECK' && ++checks === 2) return Promise.resolve({ code: 137, output: '' });
      return sh(script);
    });
    expect(result.passed).toBe(false);
    expect(result.steps.at(-1)).toEqual({
      step: 'check fails after break.sh',
      ok: false,
      detail: 'expected exit 1, got 137\n',
    });
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

describe('selfTestOps', () => {
  let ops: Scenario;
  beforeEach(() => {
    ops = {
      id: '029-bad-override',
      kind: 'ops',
      dir: '/s/029',
      meta: { ...scenario.meta, class: 'infra-config', expectedTier: 3 },
    };
  });

  /**
   * A fake live app: one bit of state that break-ops.sh sets and fix-ops.sh clears.
   * Scripts arrive as paths, since the host runs them from their files.
   */
  function fakeApp({ breaks = true, fixes = true, fixCode = 0 } = {}): {
    run: HostShell;
    scripts: string[];
  } {
    let broken = false;
    const scripts: string[] = [];
    const run: HostShell = (path) => {
      const file = path.split('/').at(-1);
      scripts.push(file ?? path);
      if (file === 'break-ops.sh') broken = breaks;
      if (file === 'fix-ops.sh') {
        broken = broken && !fixes;
        return Promise.resolve({ code: fixCode, output: fixCode ? 'restart timed out' : '' });
      }
      if (file === 'check.sh') {
        return Promise.resolve({ code: broken ? 1 : 0, output: broken ? 'got 500' : 'ok' });
      }
      return Promise.resolve({ code: 0, output: '' });
    };
    return { run, scripts };
  }

  it('passes when check passes, fails after break-ops.sh and passes after fix-ops.sh', async () => {
    const { run, scripts } = fakeApp();
    const result = await selfTestOps(ops, run);
    expect(result).toEqual({
      id: '029-bad-override',
      passed: true,
      steps: [
        { step: 'check passes on the clean app', ok: true },
        { step: 'break-ops.sh runs', ok: true },
        { step: 'check fails after break-ops.sh', ok: true },
        { step: 'fix-ops.sh runs', ok: true },
        { step: 'check passes after fix-ops.sh', ok: true },
      ],
    });
    expect(scripts).toEqual(['check.sh', 'break-ops.sh', 'check.sh', 'fix-ops.sh', 'check.sh']);
  });

  it('runs the scripts from the scenario directory', async () => {
    const paths: string[] = [];
    await selfTestOps(ops, (path) => {
      paths.push(path);
      return Promise.resolve({ code: 0, output: '' });
    });
    expect(paths.slice(0, 2)).toEqual(['/s/029/check.sh', '/s/029/break-ops.sh']);
  });

  it('fails when break-ops.sh breaks nothing, and still cleans up', async () => {
    const { run, scripts } = fakeApp({ breaks: false });
    const result = await selfTestOps(ops, run);
    expect(result.passed).toBe(false);
    expect(result.steps.slice(-2)).toEqual([
      {
        step: 'check fails after break-ops.sh',
        ok: false,
        detail: 'expected exit 1, got 0\nok',
      },
      { step: 'cleanup: fix-ops.sh runs', ok: true },
    ]);
    expect(scripts.at(-1)).toBe('fix-ops.sh');
  });

  it('fails when fix-ops.sh does not fix the bug, without running it twice', async () => {
    const { run, scripts } = fakeApp({ fixes: false });
    const result = await selfTestOps(ops, run);
    expect(result.passed).toBe(false);
    expect(result.steps.at(-1)).toEqual({
      step: 'check passes after fix-ops.sh',
      ok: false,
      detail: 'expected exit 0, got 1\ngot 500',
    });
    expect(scripts.filter((s) => s === 'fix-ops.sh')).toHaveLength(1);
  });

  it('retries fix-ops.sh as cleanup when it fails', async () => {
    const result = await selfTestOps(ops, fakeApp({ fixCode: 1 }).run);
    expect(result.passed).toBe(false);
    expect(result.steps.slice(-2)).toEqual([
      { step: 'fix-ops.sh runs', ok: false, detail: 'expected exit 0, got 1\nrestart timed out' },
      {
        step: 'cleanup: fix-ops.sh runs',
        ok: false,
        detail: 'expected exit 0, got 1\nrestart timed out',
      },
    ]);
  });

  it('does not clean up when the clean check already fails', async () => {
    const { run, scripts } = fakeApp();
    const result = await selfTestOps(ops, (path) =>
      path.endsWith('check.sh') ? Promise.resolve({ code: 7, output: '' }) : run(path),
    );
    expect(result.passed).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(scripts).toEqual([]);
  });

  it('refuses a scenario of the other kind', async () => {
    await expect(selfTestOps(scenario, fakeApp().run)).rejects.toThrow(/code scenario/);
    await expect(selfTest(ops, fakeSandbox().sh)).rejects.toThrow(/ops scenario/);
  });
});
