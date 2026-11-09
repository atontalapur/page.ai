import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scenario } from './scenario.ts';
import {
  frameLinesScript,
  framesExistScript,
  type HostShell,
  NO_CHECK_IN_SANDBOX,
  type ReportFrame,
  reportFrames,
  type SandboxShell,
  selfTest,
  selfTestOps,
  uncheckedFrames,
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
      framesExistScript([], [], {}),
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

  it('checks the report frames against meta.json frameLines right after break.sh', async () => {
    scenario.meta.report = 'GET / returned 500\n\nError: boom\n    at apps/demo-app/a.ts:3:7';
    scenario.meta.frameLines = { 'apps/demo-app/a.ts:3': '  return f();' };
    const { sh, scripts } = fakeSandbox();
    const result = await selfTest(scenario, sh);
    expect(result.passed).toBe(true);
    expect(scripts[3]).toBe(
      framesExistScript(
        [{ path: 'apps/demo-app/a.ts', line: 3, column: 7 }],
        [],
        scenario.meta.frameLines,
      ),
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

  it('skips repo paths outside a stack line', () => {
    const report = [
      'GET /?file=apps/demo-app/a.ts:1:2 returned 500',
      'Request body: {"path":"apps/demo-app/a.ts:1:2"}',
      'Failed at apps/demo-app/a.ts:1:2',
    ].join('\n');
    expect(reportFrames(report)).toEqual([]);
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

describe('uncheckedFrames', () => {
  it('lists repo frames in a form the check skips', () => {
    const lines = [
      'at /workspace/apps/demo-app/a.ts:1:2',
      'at f (./apps/demo-app/a.ts:1:2)',
      'at f ([project]/apps/demo-app/a.ts:1:2)',
      'at f (file:///workspace/apps/a.ts:9:9)',
      'at webpack-internal:///(rsc)/./apps/a.ts:9:9',
      'at f (src/lib/x.ts:1:2)',
      'at f (apps/demo-app/src/shop/cart.ts:9999)',
    ];
    expect(uncheckedFrames(lines.map((line) => `    ${line}`).join('\n'))).toEqual(lines);
  });

  it('leaves out checked, library, node, generated and non-stack lines', () => {
    const report = [
      'GET /?file=apps/demo-app/a.ts:1:2 returned 500',
      '    at f (apps/demo-app/a.ts:1:2)',
      '    at node_modules/.pnpm/pg@8.23.1/node_modules/pg/lib/client.js:694:17',
      '    at /app/node_modules/packages/x/src/a.js:1:2',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
      '    at f (apps/demo-app/.next/server/chunk.js:3:4)',
    ].join('\n');
    expect(uncheckedFrames(report)).toEqual([]);
  });
});

// Each test starts sh and node, which takes tens of ms alone but seconds when turbo runs
// every package's tests at once. Two tests timed out at the 5s default.
describe('framesExistScript', { timeout: 20_000 }, () => {
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

  function sh(script: string): { code: number | null; output: string } {
    const { status, stdout, stderr } = spawnSync('sh', ['-s'], {
      cwd: dir,
      input: script,
      encoding: 'utf8',
    });
    return { code: status, output: stdout + stderr };
  }

  function run(
    frames: ReportFrame[],
    unchecked: string[] = [],
    lines?: Record<string, string>,
  ): { code: number | null; output: string } {
    return sh(framesExistScript(frames, unchecked, lines));
  }

  it('passes when every frame is inside its file', async () => {
    await write('a/[slug]/page.tsx', 'one\ntwo two\n');
    expect(run([{ path: 'a/[slug]/page.tsx', line: 2, column: 5 }])).toEqual({
      code: 0,
      output: '',
    });
  });

  it('passes on the last line of a file with no trailing newline', async () => {
    await write('a.ts', 'one\ntwo');
    expect(run([{ path: 'a.ts', line: 2, column: 1 }]).code).toBe(0);
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

  it.each([
    [0, 1],
    [1, 0],
    [2 ** 63, 1],
    [1, Infinity],
  ])('rejects line %s, column %s', async (line, column) => {
    await write('a.ts', 'one\n');
    expect(run([{ path: 'a.ts', line, column }])).toEqual({
      code: 1,
      output: `a.ts:${line}:${column}: lines and columns are whole numbers from 1\n`,
    });
  });

  it('passes a frame at the start of a token', async () => {
    await write('a.ts', '  const { db } = await shop();\n  x.load(y);\n');
    const frames = [
      { path: 'a.ts', line: 1, column: 18 },
      { path: 'a.ts', line: 1, column: 28 },
      { path: 'a.ts', line: 2, column: 5 },
    ];
    expect(run(frames)).toEqual({ code: 0, output: '' });
  });

  it('reports a frame inside a word or on a space', async () => {
    await write('a.ts', '  await shop();\n');
    expect(run([{ path: 'a.ts', line: 1, column: 4 }])).toEqual({
      code: 1,
      output: 'a.ts:1:4: not the start of a token in "await shop();"\n',
    });
    expect(run([{ path: 'a.ts', line: 1, column: 1 }]).code).toBe(1);
  });

  it('counts columns in UTF-16 code units, as V8 does', async () => {
    await write('a.ts', '"×😀" + f();\n');
    expect(run([{ path: 'a.ts', line: 1, column: 9 }]).code).toBe(0);
    // Counting bytes would put `f` at 13, past the end of this 12-unit line.
    expect(run([{ path: 'a.ts', line: 1, column: 13 }]).code).toBe(1);
  });

  it('reports a stack line it could not check', () => {
    expect(run([], ['at /workspace/apps/a.ts:1:2'])).toEqual({
      code: 1,
      output: 'at /workspace/apps/a.ts:1:2: not a repo-relative path:line:column frame\n',
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

  describe('with frameLines', () => {
    const frame = { path: 'a.ts', line: 2, column: 3 };

    it('passes when the cited line reads as recorded', async () => {
      await write('a.ts', 'one\n  f();\r\n');
      expect(run([frame], [], { 'a.ts:2': '  f();' })).toEqual({ code: 0, output: '' });
    });

    it('reports a cited line that moved inside its file', async () => {
      // A line added at the top: line 2 is now what line 1 was, and column 3 is still the
      // start of a token, so only the recorded text catches it.
      await write('a.ts', '// new\none\n  f();\n');
      expect(run([frame], [], { 'a.ts:2': '  f();' })).toEqual({
        code: 1,
        output: 'a.ts:2:3: the line changed since the report was captured, from "f();" to "one"\n',
      });
    });

    it('reports a frame with no entry and an entry with no frame', async () => {
      await write('a.ts', 'one\n  f();\n');
      expect(run([frame], [], { 'a.ts:1': 'one' })).toEqual({
        code: 1,
        output:
          'a.ts:2:3: not in meta.json frameLines; run pnpm scenarios:frames\n' +
          'a.ts:1: in meta.json frameLines, but no frame cites it\n',
      });
    });

    it('still reports a missing file before a missing entry', () => {
      expect(run([{ path: 'gone.ts', line: 1, column: 1 }], [], {})).toEqual({
        code: 1,
        output: 'gone.ts:1:1: no such file\n',
      });
    });
  });

  describe('frameLinesScript', () => {
    it('prints each cited line keyed path:line, once per line', async () => {
      await write('a/[slug]/page.tsx', 'one\n  f(g());\r\n');
      const frames = [
        { path: 'a/[slug]/page.tsx', line: 2, column: 3 },
        { path: 'a/[slug]/page.tsx', line: 2, column: 5 },
        { path: 'a/[slug]/page.tsx', line: 1, column: 1 },
      ];
      const { code, output } = sh(frameLinesScript(frames));
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({
        'a/[slug]/page.tsx:2': '  f(g());',
        'a/[slug]/page.tsx:1': 'one',
      });
    });

    it('exits 1 for a missing file or a line past the end', async () => {
      await write('a.ts', 'one\n');
      const frames = [
        { path: 'gone.ts', line: 1, column: 1 },
        { path: 'a.ts', line: 5, column: 1 },
      ];
      expect(sh(frameLinesScript(frames))).toEqual({
        code: 1,
        output: 'gone.ts:1:1: no such file\na.ts:5:1: past the end of the file\n',
      });
    });
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
