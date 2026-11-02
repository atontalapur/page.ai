import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WORKSPACE } from '../policy/paths.ts';
import type { ExecRunner, RunRequest, RunResult } from './runner.ts';

// busybox `timeout -s KILL` exits with this when it fires (128 + SIGKILL).
const KILLED = 137;
// How long after the deadline the docker client is killed, if the timeout in the container
// didn't end the command first.
const CLIENT_GRACE_MS = 5_000;
// Characters kept per stream while a command runs. execute() trims much harder; this only
// stops a runaway command from filling the daemon's memory.
const CAPTURE_LIMIT = 1_000_000;
// docker prints this when it couldn't exec at all (container gone, daemon down). The
// command never ran, so it's a runner failure, not a result.
const DOCKER_ERROR = 'Error response from daemon:';
// Every process a command starts inherits this variable, grandchildren and new sessions
// included, so a timed-out command can be cleaned up without touching anything else.
const EXEC_TAG = 'PAGE_EXEC';
// Kills every process tagged with the id in $0. busybox has no `pkill -e`, so read environ.
const KILL_TAGGED =
  'for p in /proc/[0-9]*; do ' +
  `tr "\\0" "\\n" < "$p/environ" 2>/dev/null | grep -qx "${EXEC_TAG}=$0" && kill -9 "\${p#/proc/}"; ` +
  'done; true';

export interface DockerExecRunnerOptions {
  /** Name or id of the run's sandbox container. */
  container: string;
  workdir?: string;
  /** The docker binary. Tests can point this somewhere else. */
  docker?: string;
  /** How long after the deadline to kill the docker client. */
  clientGraceMs?: number;
}

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

/**
 * Runs commands in a sandbox container with `docker exec`. The timeout is enforced inside
 * the container with busybox `timeout`, because killing the docker client leaves the
 * command running in the container.
 */
export class DockerExecRunner implements ExecRunner {
  private readonly container: string;
  private readonly workdir: string;
  private readonly docker: string;
  private readonly clientGraceMs: number;

  constructor({
    container,
    workdir = WORKSPACE,
    docker = 'docker',
    clientGraceMs = CLIENT_GRACE_MS,
  }: DockerExecRunnerOptions) {
    this.container = container;
    this.workdir = workdir;
    this.docker = docker;
    this.clientGraceMs = clientGraceMs;
  }

  async run({ command, timeoutMs, stdin }: RunRequest): Promise<RunResult> {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const tag = randomUUID();
    const started = Date.now();
    const done = await this.spawn(
      // prettier-ignore
      ['exec', '-i', '-e', `${EXEC_TAG}=${tag}`, '-w', this.workdir, this.container,
        'timeout', '-s', 'KILL', String(seconds), 'sh', '-c', command],
      stdin ?? '',
      seconds * 1000 + this.clientGraceMs,
    );
    const elapsed = Date.now() - started;

    if (done.clientKilled || (done.code === KILLED && elapsed >= timeoutMs)) {
      // `timeout` kills only its own child. A compound command (`sleep 9; true`, or a test
      // runner's workers) leaves the rest running, so kill everything carrying the tag.
      await this.spawn(
        ['exec', this.container, 'sh', '-c', KILL_TAGGED, tag],
        '',
        this.clientGraceMs,
      );
      return { status: 'timed_out', stdout: done.stdout, stderr: done.stderr };
    }
    if (done.code === null) {
      throw new Error(`docker exec in ${this.container} ended without an exit code`);
    }
    if (done.code !== 0 && done.stderr.startsWith(DOCKER_ERROR)) {
      throw new Error(`docker exec in ${this.container} failed: ${done.stderr.trim()}`);
    }
    return { status: 'exited', exitCode: done.code, stdout: done.stdout, stderr: done.stderr };
  }

  /** Runs the docker client, killing it after `killAfterMs`. Rejects only if it can't start. */
  private spawn(
    args: string[],
    stdin: string,
    killAfterMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string; clientKilled: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.docker, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = new Capture(CAPTURE_LIMIT);
      const stderr = new Capture(CAPTURE_LIMIT);
      let clientKilled = false;

      const timer = setTimeout(() => {
        clientKilled = true;
        child.kill('SIGKILL');
      }, killAfterMs);

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
      // The command may exit without reading stdin; that's not an error.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);

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
