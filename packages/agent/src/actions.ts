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

// A fenced block with one of our tags. The closing fence must start a line, so backticks
// inside a command don't end the block early. Other tags (```ts, ```bash) are prose.
const BLOCK = new RegExp(
  `\`\`\`(${Object.values(ACTION_TAGS).join('|')})[ \\t]*\\n(?:([\\s\\S]*?)\\n)?\`\`\``,
  'g',
);

const EDIT_SHAPE =
  `A ${ACTION_TAGS.edit} block is the file path on the first line, then ${SEARCH}, the exact ` +
  `text to find, ${DIVIDER}, the text to put in its place, and ${REPLACE} on the last line.`;

/**
 * Reads the single action out of a model reply. Like upstream mini-swe-agent, a reply must
 * hold exactly one action block; anything else is a format error the model gets to fix.
 */
export function parseAction(reply: string): ParseResult {
  const blocks = [...reply.replace(/\r\n/g, '\n').matchAll(BLOCK)];
  if (blocks.length !== 1) {
    return { ok: false, error: `Expected exactly 1 action, found ${blocks.length}.` };
  }
  const [, tag, body = ''] = blocks[0]!;

  if (tag === ACTION_TAGS.submit) return { ok: true, action: { kind: 'submit' } };
  if (tag === ACTION_TAGS.edit) return parseEdit(body);

  const command = body.trim();
  if (command === '') return { ok: false, error: `The ${ACTION_TAGS.exec} block is empty.` };
  return { ok: true, action: { kind: 'exec', call: { kind: 'exec', command } } };
}

function parseEdit(body: string): ParseResult {
  const [first = '', ...rest] = body.split('\n');
  const path = first.trim();
  if (path === '' || path === SEARCH) {
    return {
      ok: false,
      error: `The first line of a ${ACTION_TAGS.edit} block must be the file path. ${EDIT_SHAPE}`,
    };
  }

  const dividers = rest.flatMap((line, i) => (line === DIVIDER ? [i] : []));
  if (rest[0] !== SEARCH || rest.at(-1) !== REPLACE || dividers.length !== 1) {
    return { ok: false, error: EDIT_SHAPE };
  }
  const divider = dividers[0]!;
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
