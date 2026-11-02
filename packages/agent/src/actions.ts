import type { EditCall, ExecCall } from '@page/toolkit';

/** What one model reply asks for: a toolkit call, or the end of the run. */
export type Action =
  { kind: 'exec'; call: ExecCall } | { kind: 'edit'; call: EditCall } | { kind: 'submit' };

export type ParseResult = { ok: true; action: Action } | { ok: false; error: string };

export const ACTION_TAGS = {
  exec: 'page_bash',
  edit: 'page_edit',
  submit: 'page_submit',
} as const;

const SEARCH = '<<<<<<< SEARCH';
const DIVIDER = '=======';
const REPLACE = '>>>>>>> REPLACE';

const TAGS: ReadonlySet<string> = new Set(Object.values(ACTION_TAGS));
const OPENING = /^\s*```(\w+)[ \t]*$/;
const isFence = (line: string) => line.trimStart().startsWith('```');
const isMarker = (line: string, marker: string) => line.trimEnd() === marker;

interface Block {
  tag: string;
  body: string[];
}

/**
 * Finds the action blocks, line by line. A block opens on a line holding just ``` and one
 * of our tags; other tags (```ts, ```bash) are prose. A bash or submit block closes at the
 * next line that starts with ```. An edit closes at the first fence after a REPLACE marker,
 * so code fences inside the text it edits don't end it early.
 */
function findBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const tag = OPENING.exec(lines[i]!)?.[1];
    i += 1;
    if (tag === undefined || !TAGS.has(tag)) continue;

    const close = tag === ACTION_TAGS.edit ? editClose(lines, i) : fenceAt(lines, i);
    if (close === -1) break; // An unclosed block holds no action.
    blocks.push({ tag, body: lines.slice(i, close) });
    i = close + 1;
  }
  return blocks;
}

function fenceAt(lines: string[], from: number): number {
  return lines.findIndex((line, i) => i >= from && isFence(line));
}

function editClose(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (!isMarker(lines[i]!, REPLACE)) continue;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    if (j < lines.length && isFence(lines[j]!)) return j;
  }
  // No REPLACE marker before a fence: close at the first fence and let parseEdit explain.
  return fenceAt(lines, from);
}

const EDIT_SHAPE =
  `A ${ACTION_TAGS.edit} block is the file path on the first line, then ${SEARCH}, the exact ` +
  `text to find, ${DIVIDER}, the text to put in its place, and ${REPLACE} on the last line.`;

/**
 * Reads the single action out of a model reply. Like upstream mini-swe-agent, a reply must
 * hold exactly one action block; anything else is a format error the model gets to fix.
 */
export function parseAction(reply: string): ParseResult {
  // The repo is LF only (.gitattributes: eol=lf), so a \r can only come from the model, and
  // keeping it in SEARCH text would stop it matching the file.
  const blocks = findBlocks(reply.replace(/\r\n/g, '\n').split('\n'));
  if (blocks.length !== 1) {
    return { ok: false, error: `Expected exactly 1 action, found ${blocks.length}.` };
  }
  const { tag, body } = blocks[0]!;

  if (tag === ACTION_TAGS.submit) return { ok: true, action: { kind: 'submit' } };
  if (tag === ACTION_TAGS.edit) return parseEdit(body);

  const command = body.join('\n').trim();
  if (command === '') return { ok: false, error: `The ${ACTION_TAGS.exec} block is empty.` };
  return { ok: true, action: { kind: 'exec', call: { kind: 'exec', command } } };
}

function parseEdit(body: string[]): ParseResult {
  const lines = [...body];
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  const [first = '', ...rest] = lines;
  const path = first.trim();
  if (path === '' || isMarker(path, SEARCH)) {
    return {
      ok: false,
      error: `The first line of a ${ACTION_TAGS.edit} block must be the file path. ${EDIT_SHAPE}`,
    };
  }

  // The first divider wins, so the new text may itself hold a ======= line.
  const divider = rest.findIndex((line) => isMarker(line, DIVIDER));
  const last = rest.length - 1;
  if (!isMarker(rest[0] ?? '', SEARCH) || !isMarker(rest[last] ?? '', REPLACE) || divider < 1) {
    return { ok: false, error: EDIT_SHAPE };
  }
  const oldText = rest.slice(1, divider).join('\n');
  const newText = rest.slice(divider + 1, -1).join('\n');
  if (oldText === newText) {
    return {
      ok: false,
      error: 'The SEARCH and REPLACE text are the same, so the edit would change nothing.',
    };
  }
  return { ok: true, action: { kind: 'edit', call: { kind: 'edit', path, oldText, newText } } };
}
