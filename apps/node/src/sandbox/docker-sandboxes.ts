import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DockerExecRunner } from '@page/toolkit';
import { sandboxRunArgs } from './run-args.ts';
import { sandboxName, type Sandbox, type Sandboxes } from './sandbox.ts';

const run = promisify(execFile);

// How long `docker run` and `docker rm` may take. A cold image start is a few seconds.
const DOCKER_TIMEOUT_MS = 60_000;

export interface DockerSandboxesOptions {
  /** The sandbox image, built from infra/sandbox/Dockerfile. */
  image: string;
  /** The docker binary. Tests point this at a stand-in. */
  docker?: string;
}

/** Runs each sandbox as a container on the local Docker daemon, under the #5 limits. */
export class DockerSandboxes implements Sandboxes {
  private readonly image: string;
  private readonly docker: string;

  constructor({ image, docker = 'docker' }: DockerSandboxesOptions) {
    this.image = image;
    this.docker = docker;
  }

  async start(runId: string): Promise<Sandbox> {
    const name = sandboxName(runId);
    try {
      await run(this.docker, sandboxRunArgs({ image: this.image, name }), {
        timeout: DOCKER_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(`could not start sandbox ${name}: ${stderrOf(error)}`, { cause: error });
    }
    return { name, runner: new DockerExecRunner({ container: name, docker: this.docker }) };
  }

  async stop({ name }: Sandbox): Promise<void> {
    try {
      // --force kills a running container; --rm on start means a stopped one is gone already.
      await run(this.docker, ['rm', '--force', name], { timeout: DOCKER_TIMEOUT_MS });
    } catch (error) {
      const stderr = stderrOf(error);
      if (stderr.includes('No such container')) return;
      throw new Error(`could not stop sandbox ${name}: ${stderr}`, { cause: error });
    }
  }
}

function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
  return String(error);
}
