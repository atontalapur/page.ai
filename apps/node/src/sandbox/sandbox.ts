import type { ExecRunner } from '@page/toolkit';

/** One run's sandbox container, and the runner that sends commands into it. */
export interface Sandbox {
  /** The container's name. */
  readonly name: string;
  readonly runner: ExecRunner;
}

/**
 * Starts and stops sandbox containers, one per run. DockerSandboxes runs real containers;
 * FakeSandboxes stands in for it in tests and under USE_FAKE_ADAPTERS.
 *
 * Both methods reject only when the container runtime itself breaks (docker missing, image
 * not built, daemon down). `stop` is safe to call on a container that already stopped.
 */
export interface Sandboxes {
  start(runId: string): Promise<Sandbox>;
  stop(sandbox: Sandbox): Promise<void>;
}

/** Every container the daemon starts is named this way, so #9 can find and reap strays. */
export const SANDBOX_PREFIX = 'pageagents-';

export const sandboxName = (runId: string) => `${SANDBOX_PREFIX}${runId}`;
