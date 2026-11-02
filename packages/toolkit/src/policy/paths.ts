import { posix } from 'node:path';

/** The repo inside the sandbox. Commands run with this as their working directory. */
export const WORKSPACE = '/workspace';

// `.github/` holds CI, which the agent must not change. `.git/` holds the repo config, where
// `core.fsmonitor` or `core.pager` would make `git status` run any program.
const PROTECTED_DIRS = new Set(['.github', '.git']);

/**
 * Checks a path the agent wants to write, for a redirect or the edit tool. Returns why it
 * is refused, or null when the write may go ahead. Relative paths resolve against
 * WORKSPACE. The check is on the text of the path; the sandbox gives the agent no way to
 * create symlinks, so it can't point one outside the repo.
 */
export function writePathRefusal(path: string): string | null {
  if (path === '') return 'empty path';
  const resolved = posix.resolve(WORKSPACE, path);
  if (!resolved.startsWith(`${WORKSPACE}/`)) return `${path} is outside the repo`;
  const segments = resolved.slice(WORKSPACE.length + 1).split('/');
  const hit = segments.find((segment) => PROTECTED_DIRS.has(segment));
  if (hit !== undefined) return `writes under ${hit}/ are not allowed`;
  return null;
}
