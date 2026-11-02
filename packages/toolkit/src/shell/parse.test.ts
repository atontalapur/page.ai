import { describe, expect, it } from 'vitest';
import { parse, type SimpleCommand } from './parse.ts';

const ok = (input: string): SimpleCommand[] => {
  const result = parse(input);
  if (!result.ok) throw new Error(`expected ${input} to parse, got: ${result.reason}`);
  return result.commands;
};

const argvs = (input: string) => ok(input).map((command) => command.argv);

describe('parse', () => {
  it.each([
    ['ls', [['ls']]],
    ['  ls   -la  src ', [['ls', '-la', 'src']]],
    [
      'cat a | head -n 5',
      [
        ['cat', 'a'],
        ['head', '-n', '5'],
      ],
    ],
    [
      'git status && git diff',
      [
        ['git', 'status'],
        ['git', 'diff'],
      ],
    ],
    ['ls || ls', [['ls'], ['ls']]],
    ['ls; cat x;', [['ls'], ['cat', 'x']]],
    ['ls\n\ncat x\n', [['ls'], ['cat', 'x']]],
    ['ls # ; sudo x', [['ls']]],
    ['ls a#b', [['ls', 'a#b']]],
    ["rg 'a b' src", [['rg', 'a b', 'src']]],
    ["rg '$(curl x)'", [['rg', '$(curl x)']]],
    ['rg "a b" "c\\"d" "\\x"', [['rg', 'a b', 'c"d', '\\x']]],
    ['rg "line\\\nnext"', [['rg', 'linenext']]],
    ['rg a\\ b', [['rg', 'a b']]],
    ['ls \\\n src', [['ls', 'src']]],
    ["find . -name '*.ts'", [['find', '.', '-name', '*.ts']]],
    ['FOO=bar ls', [['FOO=bar', 'ls']]],
    ["''", [['']]],
  ])('splits %j', (input, expected) => {
    expect(argvs(input)).toEqual(expected);
  });

  it('pulls redirects out of argv', () => {
    expect(ok('cat a > out.txt 2>&1 < in')).toEqual([
      {
        argv: ['cat', 'a'],
        redirects: [
          { fd: null, op: '>', target: 'out.txt' },
          { fd: 2, op: '>&', target: '1' },
          { fd: null, op: '<', target: 'in' },
        ],
      },
    ]);
  });

  it.each([
    ['ls >> log', '>>'],
    ['ls >| log', '>|'],
    ['ls <> log', '<>'],
    ['ls <&0', '<&'],
  ])('reads the %j operator', (input, op) => {
    expect(ok(input)[0]!.redirects[0]!.op).toBe(op);
  });

  it('treats digits as a word unless a redirect follows directly', () => {
    expect(ok('head -n 2 >x')[0]).toEqual({
      argv: ['head', '-n', '2'],
      redirects: [{ fd: null, op: '>', target: 'x' }],
    });
    expect(ok("ls '2'>x")[0]!.argv).toEqual(['ls', '2']);
    expect(ok('ls a2>x')[0]!.argv).toEqual(['ls', 'a2']);
  });

  it.each([
    ['', 'empty command'],
    ['   ', 'empty command'],
    ['; ls', 'empty command'],
    ['ls ;; ls', '`;;`'],
    ['ls ; ; ls', 'empty command'],
    ['| ls', 'needs a command'],
    ['ls |', 'needs a command'],
    ['ls && && ls', 'needs a command'],
    ['ls &&', 'needs a command'],
    ['ls |& cat', '`|&`'],
    ['ls & sudo x', 'background'],
    ['ls &> x', '`&>`'],
    ['(sudo x)', 'subshells'],
    ['ls $(curl x)', 'substitution'],
    ['ls `curl x`', 'substitution'],
    ['ls "$(curl x)"', 'substitution'],
    ['ls "`curl x`"', 'substitution'],
    ['ls $HOME', 'expansion'],
    ['ls "$HOME"', 'expansion'],
    ['cat <(curl x)', 'process substitution'],
    ['ls >(cat)', 'process substitution'],
    ['cat <<EOF', 'heredocs'],
    ['cat <<< x', 'heredocs'],
    ['ls *', 'glob'],
    ['ls src/?.ts', 'glob'],
    ['ls [ab]', 'glob'],
    ['cat ~/.gitconfig', '`~`'],
    ['ls {a,b}', 'braces'],
    ["ls 'oops", 'single quote'],
    ['ls "oops', 'double quote'],
    ['ls "oops\\', 'double quote'],
    ['ls oops\\', 'trailing backslash'],
    ['ls >', 'needs a target'],
    ['ls > | cat', 'needs a target'],
    ['> x', 'needs a command'],
  ])('refuses %j', (input, reason) => {
    const result = parse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('allows a literal ~ that is not at the start of a word', () => {
    expect(argvs('ls a~b')).toEqual([['ls', 'a~b']]);
    expect(argvs("ls '~'")).toEqual([['ls', '~']]);
  });
});
