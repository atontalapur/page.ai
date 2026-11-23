import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UserExecRunner } from '@page/toolkit';
import { SANDBOX_LIMITS } from './run-args.ts';
import { sandboxName, type Reaped, type Sandbox, type Sandboxes } from './sandbox.ts';

const run = promisify(execFile);

// How long resetting the workspace may take. git touches only what a run changed.
const RESET_TIMEOUT_MS = 120_000;

/** The user commands run as; the node image creates it and gives it /workspace. */
export const SANDBOX_USER = 'sandbox';

// What a command sees. Nothing comes from the daemon's environment, keys included.
// PAGE_SANDBOX turns on the demo app's low-memory test settings, as in the sandbox image.
const COMMAND_ENV = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  PAGE_SANDBOX: '1',
  // pnpm comes from the image's Corepack cache; commands can't download it.
  COREPACK_HOME: '/opt/corepack',
  COREPACK_ENABLE_NETWORK: '0',
};

// Run as root: ends every process the sandbox user has, and clears its scratch files.
const KILL_AND_CLEAR = `pkill -9 -u ${SANDBOX_USER}; find /tmp -mindepth 1 -user ${SANDBOX_USER} -delete; true`;
// Run as the sandbox user, which owns the repo, so restored files keep its ownership.
// node_modules and .next are ignored but were built into the image before the baseline.
const RESET = 'git reset -q --hard && git clean -qfdx -e node_modules -e .next';

export interface LocalSandboxesOptions {
  /** Runs a shell script as root, then as the sandbox user. Tests swap this out. */
  shell?: (script: string, asUser: boolean) => Promise<void>;
}

/**
 * One sandbox in the daemon's own container, for hosts that can't start containers, such
 * as Railway (docs/adr/0001-sandbox-network-policy.md). Commands run as an unprivileged
 * user in /workspace, the demo app baked into the image. There is one workspace, so one
 * run at a time: the daemon claims one job at a time. Each start kills what the last run
 * left and puts the workspace back to its baseline commit.
 */
export class LocalSandboxes implements Sandboxes {
  private active: string | undefined;
  private readonly shell: (script: string, asUser: boolean) => Promise<void>;

  constructor({ shell = runShell }: LocalSandboxesOptions = {}) {
    this.shell = shell;
  }

  async start(runId: string): Promise<Sandbox> {
    const name = sandboxName(runId);
    if (this.active !== undefined) {
      throw new Error(`could not start sandbox ${name}: ${this.active} is still running`);
    }
    try {
      await this.clean();
    } catch (error) {
      throw new Error(`could not start sandbox ${name}: ${messageOf(error)}`, { cause: error });
    }
    this.active = name;
    const runner = new UserExecRunner({
      user: SANDBOX_USER,
      env: COMMAND_ENV,
      maxProcesses: SANDBOX_LIMITS.pids,
    });
    return { name, runner };
  }

  async stop({ name }: Sandbox): Promise<void> {
    if (this.active !== name) return;
    // The workspace stays as the run left it until the next start resets it.
    try {
      await this.shell(KILL_AND_CLEAR, false);
    } catch (error) {
      throw new Error(`could not stop sandbox ${name}: ${messageOf(error)}`, { cause: error });
    } finally {
      this.active = undefined;
    }
  }

  async reap(): Promise<Reaped> {
    // A crashed daemon's run may have left processes and edits behind.
    try {
      await this.clean();
      return { removed: [], failed: [] };
    } catch (error) {
      return { removed: [], failed: [{ name: 'workspace', error: toError(error) }] };
    }
  }

  private async clean(): Promise<void> {
    await this.shell(KILL_AND_CLEAR, false);
    await this.shell(RESET, true);
  }
}

async function runShell(script: string, asUser: boolean): Promise<void> {
  const [file, args] = asUser
    ? [
        'su-exec',
        [SANDBOX_USER, 'env', '-i', 'PATH=/usr/bin:/bin', 'HOME=/tmp', 'sh', '-c', script],
      ]
    : ['sh', ['-c', script]];
  await run(file, args, { cwd: '/workspace', timeout: RESET_TIMEOUT_MS });
}

function messageOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
