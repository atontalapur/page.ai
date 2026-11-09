// Starting, talking to and stopping a sandbox container, for the scripts in this directory.
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecResult, SandboxShell } from '../src/selftest.ts';

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
