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
  /**
   * Removes every sandbox container on this host, running or not, and resolves with their
   * names. The daemon calls it at startup, before it claims anything, to clear what a
   * crashed or SIGKILLed daemon left behind. One daemon per Docker host, so every
   * `pageagents-*` container is its own.
   */
  reap(): Promise<string[]>;
}

/** Every container the daemon starts is named this way, so it can find and reap strays. */
export const SANDBOX_PREFIX = 'pageagents-';

export const sandboxName = (runId: string) => `${SANDBOX_PREFIX}${runId}`;
