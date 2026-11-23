import { WORKSPACE } from '../policy/paths.ts';
import { WrappedExecRunner, type Client } from './wrapped-runner.ts';

export interface UserExecRunnerOptions {
  /** The unprivileged user commands run as. It must own the workspace. */
  user: string;
  /** The only variables a command sees, besides the runner's own. Nothing is inherited. */
  env: Record<string, string>;
  /** Processes the user may have at once, as `ulimit -u`. */
  maxProcesses: number;
  /** Switches to `user` without forking. Tests can point this somewhere else. */
  suExec?: string;
  /** Where commands run. Tests can point this somewhere else. */
  workspace?: string;
  /** How long after the deadline to kill the client. */
  clientGraceMs?: number;
}

/**
 * Runs commands as an unprivileged local user, for a host that can't start containers
 * (docs/adr/0001-sandbox-network-policy.md). The daemon runs as root and keeps its keys in
 * its own environment; each command starts from an empty one under `env -i`, and the user
 * can't read another user's /proc/<pid>/environ. The command gets its own session, so the
 * wrapper's cleanup finds everything it started.
 */
export class UserExecRunner extends WrappedExecRunner {
  protected readonly label: string;
  private readonly user: string;
  private readonly env: Record<string, string>;
  private readonly maxProcesses: number;
  private readonly suExec: string;
  private readonly workspace: string;

  constructor({
    user,
    env,
    maxProcesses,
    suExec = 'su-exec',
    workspace = WORKSPACE,
    clientGraceMs,
  }: UserExecRunnerOptions) {
    super(clientGraceMs);
    this.user = user;
    this.env = env;
    this.maxProcesses = maxProcesses;
    this.suExec = suExec;
    this.workspace = workspace;
    this.label = `exec as ${user}`;
  }

  protected client(env: Record<string, string>, argv: string[]): Client {
    const vars = Object.entries({ ...this.env, ...env }).map(([key, value]) => `${key}=${value}`);
    return {
      file: this.suExec,
      // prettier-ignore
      args: [this.user, 'env', '-i', ...vars,
        'sh', '-c', 'ulimit -u "$0" && exec "$@"', String(this.maxProcesses), ...argv],
      // detached: its own session, which RUN's cleanup relies on.
      options: { cwd: this.workspace, detached: true },
    };
  }
}
