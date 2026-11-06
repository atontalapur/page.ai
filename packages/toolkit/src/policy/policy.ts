import { posix } from 'node:path';
import type { Tier } from '@page/contracts';
import { parse, type Redirect, type SimpleCommand } from '../shell/parse.ts';
import { writePathRefusal } from './paths.ts';

export type Verdict = { allowed: true } | { allowed: false; reason: string };

/** Checks one command's arguments (argv without the program). Returns a refusal or null. */
type ArgRule = (args: string[]) => string | null;

// Blocked at every tier, whatever the allowlist says, so the refusal names the real reason.
const BLOCKED_PROGRAMS = new Set(['sudo', 'su', 'doas', 'curl', 'wget', 'docker']);

const anyArgs: ArgRule = () => null;

const refuseFlags =
  (program: string, isBad: (arg: string) => boolean, why: string): ArgRule =>
  (args) => {
    const bad = args.find(isBad);
    return bad === undefined ? null : `${program} ${bad} is not allowed: ${why}`;
  };

const FIND_ACTIONS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

const GIT_READ_ONLY = new Set(['status', 'diff', 'log']);

const git: ArgRule = (args) => {
  const [sub, ...rest] = args;
  if (sub === undefined) return 'git needs a subcommand';
  if (sub.startsWith('-')) return 'git options before the subcommand are not allowed';
  if (!GIT_READ_ONLY.has(sub)) {
    return `git ${sub} is not allowed; git may run ${[...GIT_READ_ONLY].join(', ')}`;
  }
  const output = rest.find((arg) => arg === '--output' || arg.startsWith('--output='));
  return output === undefined ? null : `git ${sub} --output is not allowed: it writes a file`;
};

const PNPM_SCRIPTS = new Set(['test', 'lint', 'typecheck']);
const PNPM_BINS = new Set(['vitest', 'tsc', 'eslint']);
const UNDOES_TEST_GUARDS = /^--(pass-?with-?no-?tests|reporter)(=|$)/i;

// The test runner, through pnpm only. Workspace filters may come first.
//
// This is arbitrary execution, and the policy doesn't pretend otherwise: `pnpm test` runs
// the repo's scripts, configs and test files, all of which the agent can change with the
// edit tool. Protecting package.json or *.config.* wouldn't close that, since any test file
// runs code. The sandbox (#5: no network, nothing writable outside the repo and /tmp) is the
// boundary; this rule only keeps an honest agent from writing outside the repo or misreading
// a test run by accident.
const pnpm: ArgRule = (args) => {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--filter' || arg === '-F') i += 2;
    else if (arg.startsWith('--filter=') || arg === '-r' || arg === '--recursive') i += 1;
    else break;
  }
  const [sub, next] = [args[i], args[i + 1]];
  const ok =
    (sub !== undefined && (PNPM_SCRIPTS.has(sub) || PNPM_BINS.has(sub))) ||
    (sub === 'run' && next !== undefined && PNPM_SCRIPTS.has(next)) ||
    (sub === 'exec' && next !== undefined && PNPM_BINS.has(next));
  if (!ok) return 'pnpm may only run test, lint, typecheck, vitest, tsc or eslint';
  // These override the failure on a run with no test files or replace the shared reporter that
  // fails an all-skipped run, so a test that never ran would read as a pass (#65, #66).
  const undoes = args.find((arg) => UNDOES_TEST_GUARDS.test(arg));
  if (undoes !== undefined) return `pnpm ${undoes} is not allowed: no tests would exit 0`;
  const vitest = sub === 'vitest' || (sub === 'exec' && next === 'vitest');
  if (vitest && args.includes('related')) {
    return 'pnpm vitest related is not allowed: no tests would exit 0';
  }
  // Tools like tsc --outDir or eslint -o write wherever they're told. Nothing the test
  // runner needs lives outside the repo, so refuse any path that leaves it.
  const outside = args.find((arg) => {
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    return posix.isAbsolute(value) || value.split('/').includes('..');
  });
  return outside === undefined ? null : `pnpm ${outside} is not allowed: paths outside the repo`;
};

const TIER_1: ReadonlyMap<string, ArgRule> = new Map([
  ['cat', anyArgs],
  ['ls', anyArgs],
  ['head', anyArgs],
  ['tail', anyArgs],
  ['rg', refuseFlags('rg', (arg) => arg.startsWith('--pre'), 'it runs another program')],
  ['find', refuseFlags('find', (arg) => FIND_ACTIONS.has(arg), 'it runs, writes or deletes')],
  ['git', git],
  ['pnpm', pnpm],
]);

// Tier 2 adds host tools (#10) and Tier 3 the ops surface (#13). Neither runs through the
// shell, so every tier shares the Tier 1 command list for now.
const ALLOWLISTS: Record<Tier, ReadonlyMap<string, ArgRule>> = {
  1: TIER_1,
  2: TIER_1,
  3: TIER_1,
};

function isForcePush(args: string[]): boolean {
  if (args[0] !== 'push') return false;
  return args.slice(1).some(
    (arg) =>
      // --force, --force-with-lease, --force-if-includes.
      arg.startsWith('--force') ||
      // A `+src:dst` refspec forces that one ref.
      arg.startsWith('+') ||
      // -f, or a short-flag cluster such as -uf.
      /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg),
  );
}

function blocked({ argv }: SimpleCommand): string | null {
  const program = posix.basename(argv[0]!);
  if (BLOCKED_PROGRAMS.has(program)) return `${program} is blocked at every tier`;
  if (program === 'git' && isForcePush(argv.slice(1))) {
    return 'force pushes are blocked at every tier';
  }
  return null;
}

function redirectRefusal({ op, target }: Redirect): string | null {
  if (op === '<') return null;
  // `2>&1` and `<&-` duplicate or close a descriptor; `>&file` writes to file.
  if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(target)) return null;
  if (op === '<&') return `<&${target} is not a file descriptor`;
  if (target === '/dev/null') return null;
  return writePathRefusal(target);
}

function commandRefusal(command: SimpleCommand, tier: Tier): string | null {
  const block = blocked(command);
  if (block !== null) return block;

  for (const redirect of command.redirects) {
    const refusal = redirectRefusal(redirect);
    if (refusal !== null) return refusal;
  }

  const [program, ...args] = command.argv as [string, ...string[]];
  if (program.includes('=')) return 'environment assignments are not allowed';
  if (program.includes('/')) return `run ${posix.basename(program)} by name, not by path`;
  const rule = ALLOWLISTS[tier].get(program);
  if (rule === undefined) return `${program} is not allowed at tier ${tier}`;
  return rule(args);
}

/**
 * Decides whether the agent may run a command line at a tier. Every command in it (each
 * pipeline stage, each side of `&&`) must pass, so a blocked command can't ride along with
 * an allowed one. The reason is short enough for the agent to read and act on.
 */
export function checkCommand(input: string, tier: Tier): Verdict {
  const parsed = parse(input);
  if (!parsed.ok) return { allowed: false, reason: parsed.reason };
  for (const command of parsed.commands) {
    const reason = commandRefusal(command, tier);
    if (reason !== null) return { allowed: false, reason };
  }
  return { allowed: true };
}
