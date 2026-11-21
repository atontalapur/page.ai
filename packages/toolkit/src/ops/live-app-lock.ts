// A claim on one live demo app, held on this machine while something changes its settings:
// an eval playing ops scenarios, or a daemon's Tier 3 run.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One name for the app at `url`, however it is spelled: the host's case, a default port and
 * trailing slashes don't change it. The eval and the daemon both key their locks on it.
 */
export function liveAppKey(url: string): string {
  if (!URL.canParse(url)) return url.replace(/\/+$/, '');
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname.replace(/\/+$/, '')}`;
}

/** The lock directory on this machine for the app at `url`. */
export function liveAppLockDir(url: string): string {
  const hash = createHash('sha256').update(liveAppKey(url)).digest('hex').slice(0, 12);
  return join(tmpdir(), `page-eval-ops-${hash}.lock`);
}

/**
 * Claims the app at `url` for this process by creating its lock directory. Returns a release
 * function, which also runs when the process exits, or null when another process holds the
 * claim. A process killed outright leaves the directory behind; remove it by hand.
 */
export function tryLockLiveApp(url: string, dir = liveAppLockDir(url)): (() => void) | null {
  try {
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  let held = true;
  const release = () => {
    if (held) rmSync(dir, { recursive: true, force: true });
    held = false;
    process.off('exit', release);
  };
  process.once('exit', release);
  return release;
}
