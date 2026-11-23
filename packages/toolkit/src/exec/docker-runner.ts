import { WORKSPACE } from '../policy/paths.ts';
import { WrappedExecRunner, type Client } from './wrapped-runner.ts';

export { Capture } from './wrapped-runner.ts';

// docker prints one of these when it couldn't exec at all: the container is gone, the
// daemon is down, or the runtime couldn't start the process. The command never ran, so it's
// a runner failure, not a result.
const DOCKER_ERRORS = ['Error response from daemon:', 'OCI runtime exec failed:'];

export interface DockerExecRunnerOptions {
  /** Name or id of the run's sandbox container. */
  container: string;
  /** The docker binary. Tests can point this somewhere else. */
  docker?: string;
  /** How long after the deadline to kill the docker client. */
  clientGraceMs?: number;
}

/**
 * Runs commands in a sandbox container with `docker exec`. The timeout is enforced inside
 * the container with busybox `timeout`, because killing the docker client leaves the
 * command running in the container.
 */
export class DockerExecRunner extends WrappedExecRunner {
  protected readonly label: string;
  protected override readonly clientErrors = DOCKER_ERRORS;
  private readonly container: string;
  private readonly docker: string;

  constructor({ container, docker = 'docker', clientGraceMs }: DockerExecRunnerOptions) {
    super(clientGraceMs);
    this.container = container;
    this.docker = docker;
    this.label = `docker exec in ${container}`;
  }

  protected client(env: Record<string, string>, argv: string[]): Client {
    const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    // Always the workspace: the policy and the edit tool resolve relative paths against it.
    return {
      file: this.docker,
      args: ['exec', '-i', ...envArgs, '-w', WORKSPACE, this.container, ...argv],
    };
  }
}
