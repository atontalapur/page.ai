import { describe, expect, it } from 'vitest';
import { parseAction } from './actions.ts';

const fence = (tag: string, body: string) => `\`\`\`${tag}\n${body}\n\`\`\``;

function errorOf(reply: string): string {
  const result = parseAction(reply);
  if (result.ok) throw new Error(`expected a format error, got ${JSON.stringify(result.action)}`);
  return result.error;
}

describe('parseAction', () => {
  it('reads a bash block as an exec call', () => {
    const reply = `THOUGHT: look around first.\n\n${fence('page_bash', 'ls -la src')}`;
    expect(parseAction(reply)).toEqual({
      ok: true,
      action: { kind: 'exec', call: { kind: 'exec', command: 'ls -la src' } },
    });
  });

  it('keeps a multi-line command and trims the ends', () => {
    const reply = fence('page_bash', '  cat a.ts &&\n  cat b.ts  ');
    expect(parseAction(reply)).toMatchObject({
      ok: true,
      action: { call: { command: 'cat a.ts &&\n  cat b.ts' } },
    });
  });

  it('does not end the block at backticks inside a line', () => {
    const reply = fence('page_bash', "rg -n '```' docs");
    expect(parseAction(reply)).toMatchObject({
      ok: true,
      action: { call: { command: "rg -n '```' docs" } },
    });
  });

  it('reads an edit block as an edit call', () => {
    const body = [
      'src/lib/money.ts',
      '<<<<<<< SEARCH',
      "const CURRENCY = 'USDD';",
      '=======',
      "const CURRENCY = 'USD';",
      '>>>>>>> REPLACE',
    ].join('\n');
    expect(parseAction(`Fix the code.\n${fence('page_edit', body)}`)).toEqual({
      ok: true,
      action: {
        kind: 'edit',
        call: {
          kind: 'edit',
          path: 'src/lib/money.ts',
          oldText: "const CURRENCY = 'USDD';",
          newText: "const CURRENCY = 'USD';",
        },
      },
    });
  });

  it('keeps blank lines and indentation inside an edit', () => {
    const body = [
      'a.ts',
      '<<<<<<< SEARCH',
      '  if (x) {',
      '',
      '    y();',
      '=======',
      '  if (!x) {',
      '',
      '    y();',
      '>>>>>>> REPLACE',
    ].join('\n');
    expect(parseAction(fence('page_edit', body))).toMatchObject({
      ok: true,
      action: { call: { oldText: '  if (x) {\n\n    y();', newText: '  if (!x) {\n\n    y();' } },
    });
  });

  it('reads an empty search as creating a file', () => {
    const body = ['new.ts', '<<<<<<< SEARCH', '=======', 'export {};', '>>>>>>> REPLACE'].join(
      '\n',
    );
    expect(parseAction(fence('page_edit', body))).toMatchObject({
      ok: true,
      action: { call: { path: 'new.ts', oldText: '', newText: 'export {};' } },
    });
  });

  it('reads an empty replace as deleting the text', () => {
    const body = ['a.ts', '<<<<<<< SEARCH', 'debugger;', '=======', '>>>>>>> REPLACE'].join('\n');
    expect(parseAction(fence('page_edit', body))).toMatchObject({
      ok: true,
      action: { call: { oldText: 'debugger;', newText: '' } },
    });
  });

  it('reads a submit block, empty or not', () => {
    expect(parseAction('Done.\n```page_submit\n```')).toEqual({
      ok: true,
      action: { kind: 'submit' },
    });
    expect(parseAction(fence('page_submit', 'fixed the currency code'))).toEqual({
      ok: true,
      action: { kind: 'submit' },
    });
  });

  it('ignores code blocks with other tags', () => {
    const reply = `The bug:\n${fence('ts', 'const x = 1;')}\n${fence('bash', 'rm -rf /')}\n${fence('page_bash', 'ls')}`;
    expect(parseAction(reply)).toMatchObject({ ok: true, action: { kind: 'exec' } });
  });

  it('refuses a reply with no action', () => {
    expect(parseAction('I think the bug is in money.ts.')).toEqual({
      ok: false,
      error: 'Expected exactly 1 action, found 0.',
    });
  });

  it('refuses a reply with more than one action', () => {
    const reply = `${fence('page_bash', 'ls')}\n${fence('page_edit', 'x')}`;
    expect(parseAction(reply)).toEqual({
      ok: false,
      error: 'Expected exactly 1 action, found 2.',
    });
  });

  it('refuses an empty bash block', () => {
    expect(parseAction('```page_bash\n\n```')).toEqual({
      ok: false,
      error: 'The page_bash block is empty.',
    });
  });

  it('refuses an edit with no path', () => {
    const body = ['<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE'].join('\n');
    expect(errorOf(fence('page_edit', body))).toContain(
      'first line of a page_edit block must be the file path',
    );
  });

  it.each([
    ['no markers', ['a.ts', 'just text']],
    ['no divider', ['a.ts', '<<<<<<< SEARCH', 'a', '>>>>>>> REPLACE']],
    ['no closing marker', ['a.ts', '<<<<<<< SEARCH', 'a', '=======', 'b']],
    [
      'text after the closing marker',
      ['a.ts', '<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE', 'c'],
    ],
  ])('refuses an edit with %s', (_name, lines) => {
    expect(errorOf(fence('page_edit', lines.join('\n')))).toContain('<<<<<<< SEARCH');
  });

  it('refuses an edit that searches and replaces with the same text', () => {
    const body = ['a.ts', '<<<<<<< SEARCH', 'x', '=======', 'x', '>>>>>>> REPLACE'].join('\n');
    expect(parseAction(fence('page_edit', body))).toEqual({
      ok: false,
      error: 'The SEARCH and REPLACE text are the same, so the edit would change nothing.',
    });
  });

  it('keeps fenced code lines inside an edit', () => {
    const body = [
      'README.md',
      '<<<<<<< SEARCH',
      '```ts',
      'old()',
      '```',
      '=======',
      '```ts',
      'renamed()',
      '```',
      '>>>>>>> REPLACE',
    ].join('\n');
    expect(parseAction(fence('page_edit', body))).toMatchObject({
      ok: true,
      action: { call: { oldText: '```ts\nold()\n```', newText: '```ts\nrenamed()\n```' } },
    });
  });

  it('still counts the blocks around an edit that holds fences', () => {
    const body = ['a.md', '<<<<<<< SEARCH', '```', '=======', '', '>>>>>>> REPLACE'].join('\n');
    const reply = `${fence('page_bash', 'ls')}\n${fence('page_edit', body)}`;
    expect(errorOf(reply)).toBe('Expected exactly 1 action, found 2.');
  });

  it('accepts trailing spaces after the markers', () => {
    const body = ['a.ts', '<<<<<<< SEARCH  ', 'x', '======= ', 'y', '>>>>>>> REPLACE\t'].join('\n');
    expect(parseAction(fence('page_edit', body))).toMatchObject({
      ok: true,
      action: { call: { oldText: 'x', newText: 'y' } },
    });
  });

  it('accepts blank lines before the closing fence', () => {
    const body = ['a.ts', '<<<<<<< SEARCH', 'x', '=======', 'y', '>>>>>>> REPLACE', '', ''].join(
      '\n',
    );
    expect(parseAction(fence('page_edit', body))).toMatchObject({
      ok: true,
      action: { call: { oldText: 'x', newText: 'y' } },
    });
  });

  it('takes the first divider, so the new text may hold a ======= line', () => {
    const body = [
      'README.md',
      '<<<<<<< SEARCH',
      'Title',
      '=======',
      'Title',
      '=======',
      '>>>>>>> REPLACE',
    ].join('\n');
    expect(parseAction(fence('page_edit', body))).toMatchObject({
      ok: true,
      action: { call: { oldText: 'Title', newText: 'Title\n=======' } },
    });
  });

  it('ignores a block that never closes', () => {
    expect(errorOf('THOUGHT: run it.\n```page_bash\nls')).toBe(
      'Expected exactly 1 action, found 0.',
    );
  });

  it('refuses an edit that is only a path', () => {
    expect(errorOf(fence('page_edit', 'a.ts'))).toContain('<<<<<<< SEARCH');
  });

  it('accepts CRLF line endings', () => {
    const body = ['a.ts', '<<<<<<< SEARCH', 'x', '=======', 'y', '>>>>>>> REPLACE'].join('\r\n');
    expect(parseAction(`\`\`\`page_edit\r\n${body}\r\n\`\`\``)).toMatchObject({
      ok: true,
      action: { call: { path: 'a.ts', oldText: 'x', newText: 'y' } },
    });
  });

  it('reads a push block as git.pushBranch with the commit message', () => {
    const reply = `THOUGHT: tests pass.\n\n${fence('page_push_branch', '\nfix(cart): reject zero\n\nMore detail.\n')}`;
    expect(parseAction(reply)).toEqual({
      ok: true,
      action: {
        kind: 'host_tool',
        call: {
          kind: 'host_tool',
          tool: 'git.pushBranch',
          message: 'fix(cart): reject zero\n\nMore detail.',
        },
      },
    });
  });

  it('wants a commit message in a push block', () => {
    expect(errorOf(fence('page_push_branch', '  '))).toMatch(
      /commit message, and this one is empty/,
    );
  });

  it('reads a PR block as the title line and the description', () => {
    const reply = fence(
      'page_open_pr',
      '\n  fix(cart): reject zero  \nThe cart took 0.\n\nTests pass.\n',
    );
    expect(parseAction(reply)).toEqual({
      ok: true,
      action: {
        kind: 'host_tool',
        call: {
          kind: 'host_tool',
          tool: 'github.openPr',
          title: 'fix(cart): reject zero',
          body: 'The cart took 0.\n\nTests pass.',
        },
      },
    });
  });

  it('allows a PR with a title and no description', () => {
    expect(parseAction(fence('page_open_pr', 'fix it'))).toMatchObject({
      ok: true,
      action: { call: { title: 'fix it', body: '' } },
    });
  });

  it('wants a title in a PR block', () => {
    expect(errorOf(fence('page_open_pr', '\n\n'))).toMatch(/PR title on the first line/);
  });
});
