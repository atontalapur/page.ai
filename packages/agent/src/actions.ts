import type { EditCall, ExecCall, HostToolCall } from '@page/toolkit';

/** What one model reply asks for: a toolkit call, or the end of the run. */
export type Action =
  | { kind: 'exec'; call: ExecCall }
  | { kind: 'edit'; call: EditCall }
  | { kind: 'host_tool'; call: HostToolCall }
  | { kind: 'submit' }
  // The agent hands the fix to the tier above, saying why this tier can't make it.
  | { kind: 'escalate'; reason: string };

export type ParseResult = { ok: true; action: Action } | { ok: false; error: string };

export const ACTION_TAGS = {
  exec: 'page_bash',
  edit: 'page_edit',
  submit: 'page_submit',
  // Tier 2 host tools. Any tier can write them; execute() refuses them below Tier 2.
  pushBranch: 'page_push_branch',
  openPr: 'page_open_pr',
  // Tier 3 ops tools on the live app. execute() refuses them below Tier 3.
  opsConfig: 'page_ops_config',
  opsSet: 'page_ops_set',
  opsUnset: 'page_ops_unset',
  opsRestart: 'page_ops_restart',
  // Tier 3 rollback of the live app's deploy, on a node with a deployer for it.
  opsRollbackPlan: 'page_ops_rollback_plan',
  opsRollback: 'page_ops_rollback',
  // The knowledge graph, at every tier, on a node that has it.
  kgSearch: 'page_kg_search',
  kgRead: 'page_kg_read',
  kgWrite: 'page_kg_write',
  // Below Tier 3: hand the fix up when it needs what this tier can't reach.
  escalate: 'page_escalate',
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
  /** The opening and closing fence lines. */
  start: number;
  end: number;
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
    blocks.push({ tag, body: lines.slice(i, close), start: i - 1, end: close });
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

// The prompt asks for a THOUGHT section before the action; its label adds nothing on screen.
const THOUGHT_LABEL = /^\s*(?:#+\s*)?\**THOUGHT\**:?\**\s*/i;
// The format-error prompt shows its example inside these tags, and a model sometimes copies
// them into its next reply. They are never part of what it thought.
const EXAMPLE_TAGS = /<\/?response_example>/gi;

/**
 * What the model said around its action: the reply with its action blocks taken out, or
 * the model's separate reasoning when the reply says nothing else. Undefined when there is
 * neither. Read the same way as parseAction, so a block it treats as the action is the one
 * left out.
 */
export function thoughtOf(reply: string, reasoning?: string): string | undefined {
  const lines = reply.replace(/\r\n/g, '\n').split('\n');
  const inBlock = new Set<number>();
  for (const { start, end } of findBlocks(lines)) {
    for (let i = start; i <= end; i++) inBlock.add(i);
  }
  const prose = lines
    .filter((_, i) => !inBlock.has(i))
    .join('\n')
    .replace(EXAMPLE_TAGS, '')
    .replace(THOUGHT_LABEL, '')
    .trim();
  if (prose !== '') return prose;
  const own = reasoning?.trim();
  return own === '' ? undefined : own;
}

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
  if (tag === ACTION_TAGS.escalate) {
    const reason = body.join('\n').trim();
    if (reason === '') {
      return {
        ok: false,
        error: `A ${ACTION_TAGS.escalate} block says why this tier can't make the fix.`,
      };
    }
    return { ok: true, action: { kind: 'escalate', reason } };
  }
  if (tag === ACTION_TAGS.edit) return parseEdit(body);
  if (tag === ACTION_TAGS.pushBranch) return parsePushBranch(body);
  if (tag === ACTION_TAGS.openPr) return parseOpenPr(body);
  if (tag === ACTION_TAGS.opsConfig) return hostTool({ kind: 'host_tool', tool: 'ops.getConfig' });
  if (tag === ACTION_TAGS.opsRestart) return hostTool({ kind: 'host_tool', tool: 'ops.restart' });
  if (tag === ACTION_TAGS.opsSet) return parseOpsSet(body);
  if (tag === ACTION_TAGS.opsUnset) return parseOpsUnset(body);
  if (tag === ACTION_TAGS.opsRollbackPlan) {
    return hostTool({ kind: 'host_tool', tool: 'ops.planRollback' });
  }
  if (tag === ACTION_TAGS.opsRollback) return parseOpsRollback(body);
  if (tag === ACTION_TAGS.kgSearch) return parseKgSearch(body);
  if (tag === ACTION_TAGS.kgRead) return parseKgRead(body);
  if (tag === ACTION_TAGS.kgWrite) return parseKgWrite(body);

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

/** The whole block is the commit message. */
function parsePushBranch(body: string[]): ParseResult {
  const message = body.join('\n').trim();
  if (message === '') {
    return {
      ok: false,
      error: `A ${ACTION_TAGS.pushBranch} block holds the commit message, and this one is empty.`,
    };
  }
  return {
    ok: true,
    action: { kind: 'host_tool', call: { kind: 'host_tool', tool: 'git.pushBranch', message } },
  };
}

const hostTool = (call: HostToolCall): ParseResult => ({
  ok: true,
  action: { kind: 'host_tool', call },
});

/** The block's one non-blank line, or undefined when it has none or more than one. */
function oneLine(body: string[]): string | undefined {
  const lines = body.map((line) => line.trim()).filter((line) => line !== '');
  return lines.length === 1 ? lines[0] : undefined;
}

// Examples name no real setting, so the format can't hint at a fix.
const OPS_SET_SHAPE = `A ${ACTION_TAGS.opsSet} block is one line, SETTING_NAME=value.`;

/** One `KEY=value` line. The value may itself hold `=`. */
function parseOpsSet(body: string[]): ParseResult {
  const line = oneLine(body);
  const split = line?.indexOf('=') ?? -1;
  if (line === undefined || split < 1) return { ok: false, error: OPS_SET_SHAPE };
  const key = line.slice(0, split).trim();
  const value = line.slice(split + 1).trim();
  return hostTool({ kind: 'host_tool', tool: 'ops.setConfig', key, value });
}

/** One line: the setting's name. */
function parseOpsUnset(body: string[]): ParseResult {
  const key = oneLine(body);
  if (key === undefined) {
    return {
      ok: false,
      error: `A ${ACTION_TAGS.opsUnset} block is one line, the setting's name.`,
    };
  }
  return hostTool({ kind: 'host_tool', tool: 'ops.deleteConfig', key });
}

/** The search query, on one or more lines. */
function parseKgSearch(body: string[]): ParseResult {
  const query = body.join(' ').replace(/\s+/g, ' ').trim();
  if (query === '') {
    return { ok: false, error: `A ${ACTION_TAGS.kgSearch} block holds what to search for.` };
  }
  return hostTool({ kind: 'host_tool', tool: 'kg.search', query });
}

/** One line: the key of the node to read. */
function parseKgRead(body: string[]): ParseResult {
  const key = oneLine(body);
  if (key === undefined) {
    return { ok: false, error: `A ${ACTION_TAGS.kgRead} block is one line, the node's key.` };
  }
  return hostTool({ kind: 'host_tool', tool: 'kg.read', key });
}

const KG_KIND = /^[a-z][a-z_]{0,30}$/;

/**
 * The key on the first line; then `kind:`, `title:` and an optional `links:` line of
 * comma-separated `relation key` pairs; then `---` and the body.
 */
function parseKgWrite(body: string[]): ParseResult {
  const format = `A ${ACTION_TAGS.kgWrite} block is the node's key on the first line, then kind: and title: lines, an optional links: line ("relation key, relation key"), then a --- line and the body.`;
  const [first = '', ...rest] = body;
  const key = first.trim();
  const divider = rest.findIndex((line) => line.trim() === '---');
  if (key === '' || divider === -1) return { ok: false, error: format };
  const fields = new Map<string, string>();
  for (const line of rest.slice(0, divider)) {
    const match = /^\s*(kind|title|links)\s*:\s*(.*)$/.exec(line);
    if (!match) return { ok: false, error: format };
    fields.set(match[1]!, match[2]!.trim());
  }
  const nodeKind = fields.get('kind') ?? '';
  const title = fields.get('title') ?? '';
  if (!KG_KIND.test(nodeKind)) {
    return { ok: false, error: `${format} kind is lower_snake_case, such as file or function.` };
  }
  if (title === '') return { ok: false, error: format };
  const links: { relation: string; to: string }[] = [];
  for (const part of (fields.get('links') ?? '').split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const [relation = '', ...target] = trimmed.split(/\s+/);
    const to = target.join(' ');
    if (!KG_KIND.test(relation) || to === '') {
      return { ok: false, error: `${format} Each link is a lower_snake_case relation and a key.` };
    }
    links.push({ relation, to });
  }
  const text = rest
    .slice(divider + 1)
    .join('\n')
    .trim();
  return hostTool({ kind: 'host_tool', tool: 'kg.write', key, nodeKind, title, body: text, links });
}

/** One line: the id of the deployment to go back to, as the rollback plan named it. */
function parseOpsRollback(body: string[]): ParseResult {
  const to = oneLine(body);
  if (to === undefined || /\s/.test(to)) {
    return {
      ok: false,
      error: `A ${ACTION_TAGS.opsRollback} block is one line, the id of the deployment the ${ACTION_TAGS.opsRollbackPlan} block named.`,
    };
  }
  return hostTool({ kind: 'host_tool', tool: 'ops.rollback', to });
}

/** The first non-blank line is the title; the rest is the body. */
function parseOpenPr(body: string[]): ParseResult {
  const start = body.findIndex((line) => line.trim() !== '');
  if (start === -1) {
    return {
      ok: false,
      error: `A ${ACTION_TAGS.openPr} block is the PR title on the first line, then the description.`,
    };
  }
  const title = body[start]!.trim();
  const description = body
    .slice(start + 1)
    .join('\n')
    .trim();
  return {
    ok: true,
    action: {
      kind: 'host_tool',
      call: { kind: 'host_tool', tool: 'github.openPr', title, body: description },
    },
  };
}
