// Starting, talking to and stopping a sandbox container, for the scripts in this directory.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ExecResult, SandboxShell } from '../src/selftest.ts';

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

/** Runs `fn` with a shell into a fresh sandbox, and stops the sandbox however `fn` ends. */
export async function withSandbox<T>(
  image: string,
  fn: (sh: SandboxShell) => Promise<T>,
): Promise<T> {
  let name: string | undefined;
  try {
    name = startSandbox(image);
    return await fn(shellIn(name));
  } finally {
    if (name) stopSandbox(name);
  }
}

export function stopSandbox(name: string): void {
  // The container runs with --rm, so if it already exited it's gone and stop fails.
  spawnSync('docker', ['stop', '-t', '1', name], { stdio: 'ignore' });
}
