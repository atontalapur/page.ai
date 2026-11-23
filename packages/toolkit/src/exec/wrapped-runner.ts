import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecRunner, RunRequest, RunResult } from './runner.ts';

// busybox `timeout -s KILL` exits with this when it fires (128 + SIGKILL).
const KILLED = 137;
// How long after the deadline the client is killed, if the timeout inside the sandbox
// didn't end the command first.
const CLIENT_GRACE_MS = 5_000;
// Characters kept per stream while a command runs. execute() trims much harder; this only
// stops a runaway command from filling the daemon's memory.
const CAPTURE_LIMIT = 1_000_000;
// The wrapper below exits with this, after printing RUNNER_ERROR, when the sandbox lacks
// what it needs. Like a client error, the command never ran.
const RUNNER_UNUSABLE = 125;
const RUNNER_ERROR = 'page-exec:';
// Every process a command starts inherits this variable, grandchildren and new sessions
// included, so a timed-out command can be cleaned up without touching anything else.
export const EXEC_TAG = 'PAGE_EXEC';
// The session field of /proc/<pid>/stat. comm may hold spaces or `)`, so cut after the last `)`.
const SESSION_OF = (stat: string) => `sed 's/.*) //' ${stat} 2>/dev/null | cut -d" " -f4`;
// 2>/dev/null comes first so it also hides a failed `<`: a process another user owns.
const HAS_TAG = (pid: string, id: string) =>
  `tr "\\0" "\\n" 2>/dev/null < /proc/${pid}/environ | grep -qx "${EXEC_TAG}=${id}"`;
// Kills every process tagged with the id in $0. busybox has no `pkill -e`, so read environ.
// Used from outside when the client had to be killed.
export const KILL_TAGGED =
  'for p in /proc/[0-9]*; do ' +
  `${HAS_TAG('${p#/proc/}', '$0')} && kill -9 "\${p#/proc/}"; ` +
  'done; true';
// Runs `sh -c $2` under a $1-second timeout, then kills whatever it left behind, whether it
// exited or timed out: anything in this exec's session (each exec starts as its own session
// leader) or carrying the tag (in case it called setsid). A worker spawned with a fresh env
// keeps the session; only one that drops both escapes, which the sandbox's process limit
// bounds. Leftovers would otherwise hold stdout open, keeping the client from returning,
// and eat the sandbox's CPU, memory and pids.
export const RUN =
  `command -v timeout >/dev/null || { echo "${RUNNER_ERROR} no timeout in the sandbox" >&2; exit ${RUNNER_UNUSABLE}; }; ` +
  'timeout -s KILL "$1" sh -c "$2"; status=$?; ' +
  `sid=$(${SESSION_OF('/proc/$$/stat')}); ` +
  'for p in /proc/[0-9]*; do pid=${p#/proc/}; [ "$pid" = $$ ] && continue; ' +
  `if [ "$(${SESSION_OF('$p/stat')})" = "$sid" ] || ${HAS_TAG('$pid', `$${EXEC_TAG}`)}; ` +
  'then kill -9 "$pid" 2>/dev/null; fi; done; exit $status';

/** Variables every command gets, so tools print plain text the agent can read. */
export const COMMAND_ENV = { NO_COLOR: '1', FORCE_COLOR: '0' } as const;

/** Keeps the first and last `limit` characters of a stream. */
export class Capture {
  private head = '';
  private tail = '';
  private dropped = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: string): void {
    if (this.head.length < this.limit) {
      const room = this.limit - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk === '') return;
    this.tail += chunk;
    if (this.tail.length > this.limit) {
      this.dropped += this.tail.length - this.limit;
      this.tail = this.tail.slice(-this.limit);
    }
  }

  toString(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n[... ${this.dropped} characters dropped ...]\n${this.tail}`;
  }
}

/** The process that runs `argv` in the sandbox with `env` set, in the workspace. */
export interface Client {
  file: string;
  args: string[];
  options?: SpawnOptions;
}

/**
 * Runs each command through RUN in a sandbox, which enforces the timeout and cleans up
 * after it. Subclasses say how to reach the sandbox: `docker exec`, or a local user.
 */
export abstract class WrappedExecRunner implements ExecRunner {
  private readonly clientGraceMs: number;

  constructor(clientGraceMs = CLIENT_GRACE_MS) {
    this.clientGraceMs = clientGraceMs;
  }

  /** Starts each error message, e.g. `docker exec in <container>`. */
  protected abstract readonly label: string;

  /** The process that runs `argv` in the sandbox, in the workspace, with `env` set. */
  protected abstract client(env: Record<string, string>, argv: string[]): Client;

  /** Stderr prefixes the client prints when it couldn't run the command at all. */
  protected readonly clientErrors: readonly string[] = [];

  async run({ command, timeoutMs, stdin, onOutput }: RunRequest): Promise<RunResult> {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const tag = randomUUID();
    const started = Date.now();
    const done = await this.spawn(
      this.client({ [EXEC_TAG]: tag, ...COMMAND_ENV }, [
        'sh',
        '-c',
        RUN,
        'page-exec',
        String(seconds),
        command,
      ]),
      stdin ?? '',
      seconds * 1000 + this.clientGraceMs,
      onOutput,
    );
    const elapsed = Date.now() - started;

    if (done.clientKilled) {
      // The wrapper never got to clean up, so kill everything carrying the tag from outside.
      await this.spawn(this.client({}, ['sh', '-c', KILL_TAGGED, tag]), '', this.clientGraceMs);
      return { status: 'timed_out', stdout: done.stdout, stderr: done.stderr };
    }
    if (done.code === KILLED && elapsed >= timeoutMs) {
      return { status: 'timed_out', stdout: done.stdout, stderr: done.stderr };
    }
    if (done.code === null) {
      throw new Error(`${this.label} ended without an exit code`);
    }
    const runnerFailed =
      this.clientErrors.some((prefix) => done.stderr.startsWith(prefix)) ||
      (done.code === RUNNER_UNUSABLE && done.stderr.startsWith(RUNNER_ERROR));
    if (done.code !== 0 && runnerFailed) {
      throw new Error(`${this.label} failed: ${done.stderr.trim()}`);
    }
    return { status: 'exited', exitCode: done.code, stdout: done.stdout, stderr: done.stderr };
  }

  /** Runs the client, killing it after `killAfterMs`. Rejects only if it can't start. */
  private spawn(
    { file, args, options }: Client,
    stdin: string,
    killAfterMs: number,
    onOutput?: (chunk: string) => void,
  ): Promise<{ code: number | null; stdout: string; stderr: string; clientKilled: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = new Capture(CAPTURE_LIMIT);
      const stderr = new Capture(CAPTURE_LIMIT);
      let clientKilled = false;

      const timer = setTimeout(() => {
        clientKilled = true;
        child.kill('SIGKILL');
      }, killAfterMs);

      // A live view mustn't break the command, so its listener's errors are dropped.
      const live = (chunk: string) => {
        try {
          onOutput?.(chunk);
        } catch {
          // ignored
        }
      };
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdout.push(chunk);
        live(chunk);
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderr.push(chunk);
        live(chunk);
      });
      // The command may exit without reading stdin; that's not an error.
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: stdout.toString(), stderr: stderr.toString(), clientKilled });
      });
    });
  }
}
