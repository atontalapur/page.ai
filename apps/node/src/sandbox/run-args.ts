// Limits every agent sandbox runs under (#5). See docs/adr/0001-sandbox-network-policy.md.
export const SANDBOX_LIMITS = {
  cpus: 1,
  memory: '1g',
  pids: 256,
  // /tmp is RAM-backed and counts against `memory`.
  tmp: '128m',
  wallClockSeconds: 15 * 60,
} as const;

// Containers carry this label so cleanup (#9) can find strays left by a crashed daemon.
export const SANDBOX_LABEL = 'page.sandbox';

export interface SandboxRunOptions {
  image: string;
  name: string;
}

/**
 * Arguments for `docker run` that start a sandbox container in the background. The
 * container only sleeps; commands run in it with `docker exec`, and it stops itself
 * when the wall clock runs out.
 */
export function sandboxRunArgs({ image, name }: SandboxRunOptions): string[] {
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    `${SANDBOX_LABEL}=1`,
    '--network',
    'none',
    '--cpus',
    String(SANDBOX_LIMITS.cpus),
    '--memory',
    SANDBOX_LIMITS.memory,
    // Same as --memory, so the container can't spill into swap.
    '--memory-swap',
    SANDBOX_LIMITS.memory,
    '--pids-limit',
    String(SANDBOX_LIMITS.pids),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    // HOME points here, so git and other tools have somewhere to write scratch files.
    // The root filesystem isn't read-only: a volume for the repo would copy node_modules
    // on every start. The image gives the node user nothing to write outside /workspace.
    '--tmpfs',
    `/tmp:size=${SANDBOX_LIMITS.tmp}`,
    image,
    'sleep',
    String(SANDBOX_LIMITS.wallClockSeconds),
  ];
}
