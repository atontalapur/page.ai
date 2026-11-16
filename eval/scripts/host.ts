// Running an ops scenario's scripts on the host, against a live demo app.
import { spawn } from 'node:child_process';
import type { ExecResult, HostShell } from '../src/selftest.ts';

// fix-ops.sh restarts or redeploys the app and waits for it, and a rollback stand-in may
// build an image first, so this is generous. A script that hangs past it counts as failed.
export const HOST_SCRIPT_TIMEOUT_MS = 10 * 60_000;

export interface LiveApp {
  /** The demo app's base URL, such as http://localhost:3000. */
  url: string;
  /** The app's OPS_SECRET, for the ops API. */
  opsSecret: string;
}

/** Reads the live app from DEMO_APP_URL and OPS_SECRET, or undefined if either is unset. */
export function liveAppFromEnv(env: NodeJS.ProcessEnv = process.env): LiveApp | undefined {
  const url = env.DEMO_APP_URL?.trim();
  const opsSecret = env.OPS_SECRET?.trim();
  return url && opsSecret ? { url: url.replace(/\/+$/, ''), opsSecret } : undefined;
}

/**
 * Runs `command args` from the repo root with `env` over this process's env, and resolves
 * with its exit code and output, stdout and stderr together. `signal` kills it.
 */
export function runHost(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: HOST_SCRIPT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code, killed) =>
      resolve({ code: code ?? 1, output: killed ? `${output}\nkilled by ${killed}` : output }),
    );
  });
}

/** Runs each script with `sh <path>` from the repo root, with the app in its env. */
export function hostShell(app: LiveApp): HostShell {
  return (path) => runHost('sh', [path], { DEMO_APP_URL: app.url, OPS_SECRET: app.opsSecret });
}
