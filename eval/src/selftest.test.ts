import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scenario } from './scenario.ts';
import {
  framesExistScript,
  NO_CHECK_IN_SANDBOX,
  type ReportFrame,
  reportFrames,
  type SandboxShell,
  selfTest,
} from './selftest.ts';

let scenario: Scenario;
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'selftest-'));
  await writeFile(join(dir, 'break.sh'), 'BREAK');
  await writeFile(join(dir, 'check.sh'), 'CHECK');
  await writeFile(join(dir, 'reference_fix.patch'), '--- a/x\n+++ b/x\n');
  scenario = {
    id: '001-sample',
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
      framesExistScript([]),
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

  it('checks the report frames right after break.sh', async () => {
    scenario.meta.report = 'GET / returned 500\n\nError: boom\n    at apps/demo-app/a.ts:3:7';
    const { sh, scripts } = fakeSandbox();
    const result = await selfTest(scenario, sh);
    expect(result.passed).toBe(true);
    expect(scripts[3]).toBe(
      framesExistScript([{ path: 'apps/demo-app/a.ts', line: 3, column: 7 }]),
    );
    expect(scripts[2]).toBe('BREAK');
    expect(scripts[4]).toBe('CHECK');
  });

  it('fails when a report frame is out of date', async () => {
    scenario.meta.report = 'GET / returned 500\n\nError: boom\n    at apps/demo-app/a.ts:3:7';
    const { sh } = fakeSandbox();
    const result = await selfTest(scenario, (script) =>
      script.includes('apps/demo-app/a.ts')
        ? Promise.resolve({ code: 1, output: 'apps/demo-app/a.ts:3:7: past the end of the file' })
        : sh(script),
    );
    expect(result.passed).toBe(false);
    expect(result.steps.at(-1)).toEqual({
      step: 'report frames exist after break.sh',
      ok: false,
      detail: 'expected exit 0, got 1\napps/demo-app/a.ts:3:7: past the end of the file',
    });
  });
});

describe('reportFrames', () => {
  it('finds repo frames, with or without a function name', () => {
    const report = [
      'GET /products/x returned 500',
      '',
      'TypeError: boom',
      '    at ProductPage (apps/demo-app/src/app/products/[slug]/page.tsx:15:73)',
      '    at async packages/toolkit/src/a.ts:2:4',
    ].join('\n');
    expect(reportFrames(report)).toEqual([
      { path: 'apps/demo-app/src/app/products/[slug]/page.tsx', line: 15, column: 73 },
      { path: 'packages/toolkit/src/a.ts', line: 2, column: 4 },
    ]);
  });

  it('skips library, node and absolute frames', () => {
    const report = [
      'error: boom',
      '    at node_modules/.pnpm/pg@8.23.1/node_modules/pg/lib/client.js:694:17',
      '    at node_modules/packages/x/index.js:1:2',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
      '    at /workspace/apps/demo-app/a.ts:1:2',
    ].join('\n');
    expect(reportFrames(report)).toEqual([]);
  });

  it('skips a path with no line and column', () => {
    expect(reportFrames("scandir 'apps/demo-app/migrations'")).toEqual([]);
  });

  it('finds a frame in a route group', () => {
    const report = 'at CartPage (apps/demo-app/src/app/(shop)/cart/page.tsx:18:44)';
    expect(reportFrames(report)).toEqual([
      { path: 'apps/demo-app/src/app/(shop)/cart/page.tsx', line: 18, column: 44 },
    ]);
  });

  it('skips dependency and build output frames under a workspace', () => {
    const report = [
      'at apps/demo-app/node_modules/foo/index.js:1:2',
      'at f (apps/demo-app/.next/server/chunk.js:3:4)',
    ].join('\n');
    expect(reportFrames(report)).toEqual([]);
  });

  it('lists a repeated frame once', () => {
    const frame = 'apps/demo-app/a.ts:1:2';
    expect(reportFrames(`at ${frame}\nat f (${frame})`)).toEqual([
      { path: 'apps/demo-app/a.ts', line: 1, column: 2 },
    ]);
  });
});

describe('framesExistScript', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frames-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(path: string, text: string): Promise<void> {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }

  function run(frames: ReportFrame[]): { code: number | null; output: string } {
    const { status, stdout, stderr } = spawnSync('sh', ['-s'], {
      cwd: dir,
      input: framesExistScript(frames),
      encoding: 'utf8',
    });
    return { code: status, output: stdout + stderr };
  }

  it('passes when every frame is inside its file', async () => {
    await write('a/[slug]/page.tsx', 'one\ntwo two\n');
    expect(run([{ path: 'a/[slug]/page.tsx', line: 2, column: 7 }])).toEqual({
      code: 0,
      output: '',
    });
  });

  it('passes on the last line of a file with no trailing newline', async () => {
    await write('a.ts', 'one\ntwo');
    expect(run([{ path: 'a.ts', line: 2, column: 3 }]).code).toBe(0);
  });

  it('reports a missing file', () => {
    expect(run([{ path: 'gone.ts', line: 1, column: 1 }])).toEqual({
      code: 1,
      output: 'gone.ts:1:1: no such file\n',
    });
  });

  it('reports a line past the end of the file', async () => {
    await write('a.ts', 'one\n');
    expect(run([{ path: 'a.ts', line: 2, column: 1 }])).toEqual({
      code: 1,
      output: 'a.ts:2:1: past the end of the file\n',
    });
  });

  it('reports a column past the end of the line', async () => {
    await write('a.ts', 'one\n');
    expect(run([{ path: 'a.ts', line: 1, column: 4 }])).toEqual({
      code: 1,
      output: 'a.ts:1:4: past the end of the line\n',
    });
  });

  it('reports every bad frame, and keeps a path with a quote or $ literal', async () => {
    await write(`it's$HOME.ts`, 'one\n');
    const { code, output } = run([
      { path: 'gone.ts', line: 1, column: 1 },
      { path: `it's$HOME.ts`, line: 1, column: 1 },
      { path: `it's$HOME.ts`, line: 9, column: 1 },
    ]);
    expect(code).toBe(1);
    expect(output).toBe(`gone.ts:1:1: no such file\nit's$HOME.ts:9:1: past the end of the file\n`);
  });
});
