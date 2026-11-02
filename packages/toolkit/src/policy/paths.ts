import { posix } from 'node:path';

/** The repo inside the sandbox. Commands run with this as their working directory. */
export const WORKSPACE = '/workspace';

// `.github/` holds CI, which the agent must not change. `.git/` holds the repo config, where
// `core.fsmonitor` or `core.pager` would make `git status` run any program. `node_modules/`
// holds pnpm's symlinks, which point to other packages and to the store, so a path through
// one can land anywhere.
const PROTECTED_DIRS = new Set(['.github', '.git', 'node_modules']);

/**
 * Checks a path the agent wants to write, for a redirect or the edit tool. Returns why it
 * is refused, or null when the write may go ahead. Relative paths resolve against
 * WORKSPACE. The check is on the text of the path, and `sh` follows symlinks before it
 * applies `..`, so `..` is refused outright and so is `node_modules/`, where the symlinks
 * are. The repo tracks no symlinks of its own.
 */
export function writePathRefusal(path: string): string | null {
  if (path === '') return 'empty path';
  if (path.split('/').includes('..')) return `${path} uses .., which is not allowed`;
  const resolved = posix.resolve(WORKSPACE, path);
  if (!resolved.startsWith(`${WORKSPACE}/`)) return `${path} is outside the repo`;
  const segments = resolved.slice(WORKSPACE.length + 1).split('/');
  const hit = segments.find((segment) => PROTECTED_DIRS.has(segment));
  if (hit !== undefined) return `writes under ${hit}/ are not allowed`;
  return null;
}
