import { describe, expect, it } from 'vitest';
import { SANDBOX_LABEL, sandboxRunArgs } from './run-args.ts';

const args = sandboxRunArgs({ image: 'ghcr.io/x/sandbox:abc', name: 'run-1' });

// The value that follows a flag, so the tests don't depend on argument order.
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

describe('sandboxRunArgs', () => {
  it('starts a detached container that is removed when it stops', () => {
    expect(args[0]).toBe('run');
    expect(args).toContain('--detach');
    expect(args).toContain('--rm');
    expect(flag('--name')).toBe('run-1');
    expect(flag('--label')).toBe(`${SANDBOX_LABEL}=1`);
  });

  it('cuts off the network', () => {
    expect(flag('--network')).toBe('none');
  });

  it('caps CPU, memory, swap and process count', () => {
    expect(flag('--cpus')).toBe('1');
    expect(flag('--memory')).toBe('1g');
    expect(flag('--memory-swap')).toBe('1g');
    expect(flag('--pids-limit')).toBe('256');
  });

  it('drops privileges', () => {
    expect(flag('--cap-drop')).toBe('ALL');
    expect(flag('--security-opt')).toBe('no-new-privileges');
  });

  it('makes the root read-only with only /tmp and the repo writable', () => {
    expect(args).toContain('--read-only');
    expect(flag('--tmpfs')).toBe('/tmp');
    expect(flag('--mount')).toBe('type=volume,dst=/workspace');
  });

  it('ends with the image and a 15 minute sleep', () => {
    expect(args.slice(-3)).toEqual(['ghcr.io/x/sandbox:abc', 'sleep', '900']);
  });
});
