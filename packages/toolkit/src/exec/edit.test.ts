import { describe, expect, it } from 'vitest';
import { execute } from './execute.ts';
import { MAX_EDIT_BYTES, shellQuote } from './edit.ts';
import { FakeRunner } from './fake-runner.ts';
import type { RunRequest, RunResult } from './runner.ts';

const W = '/workspace';

/** A FakeRunner over an in-memory filesystem that understands the edit tool's commands. */
function fsRunner(files: Record<string, string>) {
  const exited = (code: number, stdout = '', stderr = '') =>
    FakeRunner.exited(code, stdout, stderr);
  return new FakeRunner(({ command, stdin = '' }: RunRequest): RunResult => {
    const create = /^if \[ -e '([^']+)' \]/.exec(command);
    if (create) {
      const path = create[1]!;
      if (path in files) return exited(1, '', 'exists\n');
      files[path] = stdin;
      return exited(0);
    }
    const read = /^\[ -f '([^']+)' \]/.exec(command);
    if (read) {
      const content = files[read[1]!];
      return content === undefined ? exited(1, '', 'missing\n') : exited(0, content);
    }
    const write = /^cat > '([^']+)'$/.exec(command);
    if (write) {
      files[write[1]!] = stdin;
      return exited(0);
    }
    throw new Error(`unexpected command: ${command}`);
  });
}

const edit = (path: string, oldText: string, newText: string) => ({
  kind: 'edit' as const,
  path,
  oldText,
  newText,
});

describe('execute edit', () => {
  it('replaces the one match and records the edit as JSON input', async () => {
    const files = { [`${W}/src/a.ts`]: 'const a = 1;\nconst b = 2;\n' };
    const result = await execute(edit('src/a.ts', 'a = 1', 'a = 3'), {
      tier: 1,
      runner: fsRunner(files),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'edit',
        input: JSON.stringify({ path: 'src/a.ts', oldText: 'a = 1', newText: 'a = 3' }),
        exitCode: 0,
        output: 'edited src/a.ts',
      },
    });
    expect(files[`${W}/src/a.ts`]).toBe('const a = 3;\nconst b = 2;\n');
  });

  it('writes newText literally, even with $ patterns', async () => {
    const files = { [`${W}/a.ts`]: 'x' };
    await execute(edit('a.ts', 'x', "$&$'$1"), { tier: 1, runner: fsRunner(files) });
    expect(files[`${W}/a.ts`]).toBe("$&$'$1");
  });

  it('creates a file when oldText is empty', async () => {
    const files: Record<string, string> = {};
    const result = await execute(edit('src/new.ts', '', 'export {};\n'), {
      tier: 1,
      runner: fsRunner(files),
    });
    expect(result.ok && result.value.output).toBe('created src/new.ts');
    expect(files[`${W}/src/new.ts`]).toBe('export {};\n');
  });

  it('will not create over an existing file', async () => {
    const files = { [`${W}/a.ts`]: 'old' };
    const result = await execute(edit('a.ts', '', 'new'), { tier: 1, runner: fsRunner(files) });
    expect(result).toMatchObject({ ok: false, error: { type: 'failed', exitCode: 1 } });
    expect(files[`${W}/a.ts`]).toBe('old');
  });

  it.each([
    ['nope', 'oldText was not found in a.ts'],
    ['x', 'oldText appears 3 times in a.ts; include more context so it matches once'],
  ])('fails when %j does not match exactly once', async (oldText, message) => {
    const files = { [`${W}/a.ts`]: 'x-x-x' };
    const result = await execute(edit('a.ts', oldText, 'y'), {
      tier: 1,
      runner: fsRunner(files),
    });
    expect(result).toMatchObject({ ok: false, error: { type: 'failed', output: message } });
    expect(files[`${W}/a.ts`]).toBe('x-x-x');
  });

  it('counts matches that do not overlap', async () => {
    const files = { [`${W}/a.ts`]: 'aaa' };
    const result = await execute(edit('a.ts', 'aa', 'b'), { tier: 1, runner: fsRunner(files) });
    expect(result.ok).toBe(true);
    expect(files[`${W}/a.ts`]).toBe('ba');
  });

  it('passes on a failed read', async () => {
    const result = await execute(edit('gone.ts', 'a', 'b'), { tier: 1, runner: fsRunner({}) });
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'failed', exitCode: 1, output: '[stderr]\nmissing\n' },
    });
  });

  it('refuses a file that is not UTF-8', async () => {
    const files = { [`${W}/logo.png`]: 'PNG�' };
    const result = await execute(edit('logo.png', 'PNG', 'x'), {
      tier: 1,
      runner: fsRunner(files),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'failed', output: 'logo.png is not a UTF-8 text file' },
    });
  });

  it('reports a timeout', async () => {
    const runner = new FakeRunner(() => FakeRunner.timedOut());
    const result = await execute(edit('a.ts', 'a', 'b'), { tier: 1, runner });
    expect(result).toMatchObject({
      ok: false,
      error: { type: 'timed_out', output: 'a.ts: timed out' },
    });
  });

  it.each([
    ['../outside.ts', 'outside the repo'],
    ['/etc/passwd', 'outside the repo'],
    ['.github/workflows/ci.yml', 'under .github/'],
    ['.git/config', 'under .git/'],
    ['', 'empty path'],
  ])('refuses %j without calling the runner', async (path, reason) => {
    const runner = new FakeRunner();
    const result = await execute(edit(path, 'a', 'b'), { tier: 1, runner });
    expect(result).toMatchObject({ ok: false, error: { type: 'refused' } });
    expect(!result.ok && result.error.type === 'refused' && result.error.message).toContain(reason);
    expect(runner.requests).toEqual([]);
  });

  it('uses absolute, quoted paths and a size guard in its commands', async () => {
    const runner = new FakeRunner(() => FakeRunner.exited(0, 'a'));
    await execute(edit("it's.ts", 'a', 'b'), { tier: 1, runner });
    const [read, write] = runner.requests.map((request) => request.command);
    expect(read).toContain(`[ -f '${W}/it'\\''s.ts' ]`);
    expect(read).toContain(`-le ${MAX_EDIT_BYTES}`);
    expect(write).toBe(`cat > '${W}/it'\\''s.ts'`);
  });
});

describe('shellQuote', () => {
  it.each([
    ['a b', "'a b'"],
    ["it's", "'it'\\''s'"],
    ['$(x)', "'$(x)'"],
  ])('quotes %j', (value, expected) => {
    expect(shellQuote(value)).toBe(expected);
  });
});
