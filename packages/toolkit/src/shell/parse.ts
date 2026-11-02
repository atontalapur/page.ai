// A small parser for the POSIX sh subset the agent may use. It does not try to understand
// everything sh does. Anything it can't reason about (expansion, substitution, subshells,
// heredocs, globs, background jobs) is refused, so a blocked command can't hide inside an
// allowed one. What it accepts runs under `sh -c` exactly as parsed here.

export type RedirectOp = '<' | '>' | '>>' | '>|' | '<>' | '>&' | '<&';

export interface Redirect {
  /** The file descriptor before the operator, if one was written (`2>`). */
  fd: number | null;
  op: RedirectOp;
  target: string;
}

export interface SimpleCommand {
  argv: string[];
  redirects: Redirect[];
}

export type ParseResult = { ok: true; commands: SimpleCommand[] } | { ok: false; reason: string };

type Token =
  | { type: 'word'; value: string; quoted: boolean }
  | { type: 'sep'; value: '|' | '||' | '&&' | ';' | '\n' }
  | { type: 'redirect'; op: RedirectOp; fd: number | null };

class Refusal extends Error {}

// A declaration, not an arrow, so TypeScript narrows on the `never` after a call.
function refuse(reason: string): never {
  throw new Refusal(reason);
}

const BLANK = new Set([' ', '\t']);
// Characters that end an unquoted word.
const META = new Set([' ', '\t', '\n', '|', '&', ';', '<', '>', '(', ')']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const peek = (offset: number) => input[i + offset];

  while (i < input.length) {
    const c = input[i]!;

    if (BLANK.has(c)) {
      i += 1;
      continue;
    }
    if (c === '#') {
      // A comment runs to the end of the line.
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '\n' || c === ';') {
      if (peek(1) === ';') refuse('`;;` is not allowed');
      tokens.push({ type: 'sep', value: c });
      i += 1;
      continue;
    }
    if (c === '|') {
      if (peek(1) === '|') {
        tokens.push({ type: 'sep', value: '||' });
        i += 2;
      } else if (peek(1) === '&') {
        refuse('`|&` is not allowed');
      } else {
        tokens.push({ type: 'sep', value: '|' });
        i += 1;
      }
      continue;
    }
    if (c === '&') {
      if (peek(1) === '&') {
        tokens.push({ type: 'sep', value: '&&' });
        i += 2;
        continue;
      }
      if (peek(1) === '>') refuse('`&>` is not allowed; use `> file 2>&1`');
      refuse('background jobs (`&`) are not allowed');
    }
    if (c === '(' || c === ')') refuse('subshells are not allowed');
    if (c === '<' || c === '>') {
      i = readRedirect(input, i, null, tokens);
      continue;
    }

    // A word. A run of digits directly before `<` or `>` is a file descriptor instead.
    const { value, quoted, end } = readWord(input, i);
    i = end;
    const next = input[i];
    if (!quoted && /^\d+$/.test(value) && (next === '<' || next === '>')) {
      i = readRedirect(input, i, Number(value), tokens);
      continue;
    }
    // Only a line continuation, which sh drops.
    if (value === '' && !quoted) continue;
    tokens.push({ type: 'word', value, quoted });
  }

  return tokens;
}

function readRedirect(input: string, i: number, fd: number | null, tokens: Token[]): number {
  const two = input.slice(i, i + 2);
  if (input.startsWith('<<', i)) refuse('heredocs are not allowed');
  if (input.startsWith('<(', i) || input.startsWith('>(', i)) {
    refuse('process substitution is not allowed');
  }
  const ops: RedirectOp[] = ['>>', '>|', '<>', '>&', '<&'];
  const op = ops.find((candidate) => candidate === two) ?? (input[i] as '<' | '>');
  tokens.push({ type: 'redirect', op, fd });
  return i + op.length;
}

function readWord(input: string, i: number): { value: string; quoted: boolean; end: number } {
  let value = '';
  let quoted = false;
  const first = i;

  while (i < input.length && !META.has(input[i]!)) {
    const c = input[i]!;

    if (c === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) refuse('unterminated single quote');
      value += input.slice(i + 1, close);
      quoted = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      quoted = true;
      for (;;) {
        if (i >= input.length) refuse('unterminated double quote');
        const d = input[i]!;
        if (d === '"') {
          i += 1;
          break;
        }
        if (d === '$' || d === '`') refuse('expansion and command substitution are not allowed');
        if (d === '\\') {
          const e = input[i + 1];
          if (e === undefined) refuse('unterminated double quote');
          // Inside double quotes a backslash only escapes these.
          if (e === '"' || e === '\\' || e === '$' || e === '`') {
            value += e;
          } else if (e !== '\n') {
            value += `\\${e}`;
          }
          i += 2;
          continue;
        }
        value += d;
        i += 1;
      }
      continue;
    }
    if (c === '\\') {
      const e = input[i + 1];
      if (e === undefined) refuse('trailing backslash');
      // A backslash-newline is a line continuation and leaves nothing behind.
      if (e !== '\n') {
        value += e;
        quoted = true;
      }
      i += 2;
      continue;
    }
    if (c === '$' || c === '`') refuse('expansion and command substitution are not allowed');
    if (c === '*' || c === '?' || c === '[') {
      refuse('unquoted glob characters are not allowed; quote them or use find or rg -g');
    }
    if (c === '~' && i === first) refuse('`~` expansion is not allowed; use a path in the repo');
    if (c === '{' || c === '}') refuse('unquoted braces are not allowed; quote them');

    value += c;
    i += 1;
  }

  return { value, quoted, end: i };
}

/**
 * Splits a command line into the simple commands sh would run. Every pipeline stage and
 * every command joined by `&&`, `||`, `;` or a newline comes back as its own entry, with
 * its redirects pulled out of argv.
 */
export function parse(input: string): ParseResult {
  try {
    const tokens = tokenize(input);
    const commands: SimpleCommand[] = [];
    let current: SimpleCommand = { argv: [], redirects: [] };
    let previous: Token | undefined;

    const isEmpty = (command: SimpleCommand) =>
      command.argv.length === 0 && command.redirects.length === 0;

    for (let t = 0; t < tokens.length; t += 1) {
      const token = tokens[t]!;
      if (token.type === 'word') {
        current.argv.push(token.value);
      } else if (token.type === 'redirect') {
        const target = tokens[t + 1];
        if (target?.type !== 'word') refuse('a redirect needs a target');
        current.redirects.push({ fd: token.fd, op: token.op, target: target.value });
        t += 1;
      } else {
        if (isEmpty(current)) {
          // A newline or `;` after nothing is harmless; `| x` or `&& x` is a syntax error.
          if (token.value === ';' || token.value === '\n') {
            if (token.value === ';' && previous?.type !== 'word') refuse('empty command');
          } else {
            refuse(`\`${token.value}\` needs a command on both sides`);
          }
        } else {
          commands.push(current);
          current = { argv: [], redirects: [] };
        }
      }
      previous = token;
    }

    if (isEmpty(current)) {
      if (previous?.type === 'sep' && ['|', '||', '&&'].includes(previous.value)) {
        refuse(`\`${previous.value}\` needs a command on both sides`);
      }
    } else {
      commands.push(current);
    }

    for (const command of commands) {
      if (command.argv.length === 0) refuse('a redirect needs a command');
    }
    if (commands.length === 0) refuse('empty command');

    return { ok: true, commands };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}
