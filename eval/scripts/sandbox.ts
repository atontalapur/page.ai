// Starting, talking to and stopping a sandbox container, for the scripts in this directory.
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { applyPatchScript, type ExecResult, type SandboxShell } from '../src/selftest.ts';

const execFileAsync = promisify(execFile);
const SANDBOX_RUN = 'apps/node/scripts/sandbox-run.ts';

/** Starts a sandbox the way the daemon starts one and returns its name. */
export function startSandbox(image: string): string {
  return execFileSync('node', [SANDBOX_RUN, image], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

/** startSandbox without blocking. Docker's stderr ends up in the error if the start fails. */
export async function startSandboxAsync(image: string): Promise<string> {
  const { stdout } = await execFileAsync('node', [SANDBOX_RUN, image], { encoding: 'utf8' });
  return stdout.trim();
}

/** A shell into the container that takes its script over stdin (`sh -s` in /workspace). */
export function shellIn(name: string): SandboxShell {
  return (script) =>
    new Promise<ExecResult>((resolve, reject) => {
      const child = spawn('docker', ['exec', '-i', '-w', '/workspace', name, 'sh', '-s'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Decoded once at the end: a chunk can end in the middle of a UTF-8 character, and
      // agentDiff's output is a patch that has to come through byte for byte.
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString('utf8') }),
      );
      // If docker exits before reading the whole script, the write gets EPIPE. Let
      // 'close' report the exit code instead of crashing on the stream error.
      child.stdin.on('error', () => {});
      child.stdin.end(script);
    });
}

// The repo starts over from the broken tree, as the Dockerfile's baseline did, so the bug
// is the only commit. In production it's already in HEAD; an uncommitted break would show
// up in `git diff`, and an extra commit in `git log`.
const RECOMMIT = [
  'rm -rf .git',
  'git init -q -b main',
  'git add -A',
  'git -c user.name=sandbox -c user.email=sandbox@page.invalid commit -qm baseline',
].join(' && ');

/**
 * Runs break.sh, then makes the broken code the sandbox repo's only commit. Resolves that
 * commit's SHA.
 */
export async function plantBug(sh: SandboxShell, breakScript: string): Promise<string> {
  const broke = await sh(breakScript);
  if (broke.code !== 0) throw new Error(`break.sh exited ${broke.code}:\n${broke.output}`);
  const committed = await sh(RECOMMIT);
  if (committed.code !== 0)
    throw new Error(`recommitting after break.sh failed:\n${committed.output}`);
  const head = await sh('git rev-parse HEAD');
  const sha = head.output.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(sha))
    throw new Error(`reading the baseline commit failed:\n${head.output}`);
  return sha;
}

/**
 * Everything the agent changed since `baseline` (the SHA `plantBug` resolved), including
 * new files and commits it made itself, as a patch `git apply` takes. The SHA is fixed up
 * front because the agent can rewrite the root commit with an amend or a rebase.
 */
export async function agentDiff(sh: SandboxShell, baseline: string): Promise<string> {
  // The shell merges stderr into the output, so git's warnings would corrupt the patch.
  const diff = await sh(
    'git add -A >/dev/null 2>&1 && ' +
      `git diff --cached --binary --no-ext-diff --no-textconv ${baseline} 2>/dev/null`,
  );
  if (diff.code !== 0) throw new Error(`git diff exited ${diff.code}`);
  return diff.output;
}

/**
 * check.sh on `diff` in a sandbox of its own: break.sh, the agent's patch, then the check.
 * The agent's sandbox may have only seconds left on its wall clock when the agent stops,
 * so the check can't run there. Resolves whether the check passed.
 */
export async function checkInFreshSandbox(
  image: string,
  scripts: { breakScript: string; checkScript: string },
  diff: string,
): Promise<boolean> {
  return withSandbox(image, async (sh) => {
    await plantBug(sh, scripts.breakScript);
    if (diff !== '') {
      const applied = await sh(applyPatchScript(diff));
      if (applied.code !== 0) throw new Error(`the agent's diff didn't apply:\n${applied.output}`);
    }
    return (await sh(scripts.checkScript)).code === 0;
  });
}

/**
 * Runs `fn` with a shell into a fresh sandbox, and stops the sandbox however `fn` ends.
 * Safe to run several at once: start and stop don't block, and each sandbox has its own
 * random name, its own /tmp and no ports or host mounts (sandboxRunArgs).
 */
export async function withSandbox<T>(
  image: string,
  fn: (sh: SandboxShell) => Promise<T>,
): Promise<T> {
  let name: string | undefined;
  try {
    name = await startSandboxAsync(image);
    return await fn(shellIn(name));
  } finally {
    if (name) await stopSandboxAsync(name);
  }
}

// The container runs with --rm, so if it already exited it's gone and stop fails.
function stopArgs(name: string): string[] {
  return ['stop', '-t', '1', name];
}

export function stopSandbox(name: string): void {
  spawnSync('docker', stopArgs(name), { stdio: 'ignore' });
}

/** stopSandbox without blocking. */
export async function stopSandboxAsync(name: string): Promise<void> {
  await execFileAsync('docker', stopArgs(name)).catch(() => {});
}
