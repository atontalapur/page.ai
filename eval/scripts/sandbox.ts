// Starting, talking to and stopping a sandbox container, for the scripts in this directory.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { applyPatchScript, type ExecResult, type SandboxShell } from '../src/selftest.ts';

/** Starts a sandbox the way the daemon starts one and returns its name. */
export function startSandbox(image: string): string {
  return execFileSync('node', ['apps/node/scripts/sandbox-run.ts', image], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

/** A shell into the container that takes its script over stdin (`sh -s` in /workspace). */
export function shellIn(name: string): SandboxShell {
  return (script) =>
    new Promise<ExecResult>((resolve, reject) => {
      const child = spawn('docker', ['exec', '-i', '-w', '/workspace', name, 'sh', '-s'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, output }));
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

/** Runs break.sh, then makes the broken code the sandbox repo's only commit. */
export async function plantBug(sh: SandboxShell, breakScript: string): Promise<void> {
  const broke = await sh(breakScript);
  if (broke.code !== 0) throw new Error(`break.sh exited ${broke.code}:\n${broke.output}`);
  const committed = await sh(RECOMMIT);
  if (committed.code !== 0)
    throw new Error(`recommitting after break.sh failed:\n${committed.output}`);
}

/**
 * Everything the agent changed since `plantBug`, including new files and commits it made
 * itself, as a patch `git apply` takes.
 */
export async function agentDiff(sh: SandboxShell): Promise<string> {
  // The shell merges stderr into the output, so git's warnings would corrupt the patch.
  const diff = await sh(
    'git add -A >/dev/null 2>&1 && ' +
      'git diff --cached --binary --no-ext-diff --no-textconv ' +
      '"$(git rev-list --max-parents=0 HEAD)" 2>/dev/null',
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
  const name = startSandbox(image);
  try {
    const sh = shellIn(name);
    await plantBug(sh, scripts.breakScript);
    if (diff !== '') {
      const applied = await sh(applyPatchScript(diff));
      if (applied.code !== 0) throw new Error(`the agent's diff didn't apply:\n${applied.output}`);
    }
    return (await sh(scripts.checkScript)).code === 0;
  } finally {
    stopSandbox(name);
  }
}

export function stopSandbox(name: string): void {
  // The container runs with --rm, so if it already exited it's gone and stop fails.
  spawnSync('docker', ['stop', '-t', '1', name], { stdio: 'ignore' });
}
