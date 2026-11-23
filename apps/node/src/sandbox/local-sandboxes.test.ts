import { UserExecRunner } from '@page/toolkit';
import { describe, expect, it } from 'vitest';
import { LocalSandboxes } from './local-sandboxes.ts';

/** Records each script and who ran it; `fail` makes the matching script reject. */
function recorder(fail?: RegExp) {
  const calls: { script: string; asUser: boolean }[] = [];
  const shell = (script: string, asUser: boolean) => {
    calls.push({ script, asUser });
    if (fail?.test(script)) {
      return Promise.reject(Object.assign(new Error('failed'), { stderr: 'git: not a repo\n' }));
    }
    return Promise.resolve();
  };
  return { calls, sandboxes: new LocalSandboxes({ shell }) };
}

describe('LocalSandboxes', () => {
  it('kills leftovers as root, then resets the workspace as the sandbox user', async () => {
    const { calls, sandboxes } = recorder();
    const sandbox = await sandboxes.start('run-1');

    expect(sandbox.name).toBe('pageagents-run-1');
    expect(sandbox.runner).toBeInstanceOf(UserExecRunner);
    expect(calls.map((c) => c.asUser)).toEqual([false, true]);
    expect(calls[0]?.script).toContain('pkill -9 -u sandbox');
    expect(calls[1]?.script).toContain('git reset -q --hard');
    // The baked-in dependencies and route types survive the clean.
    expect(calls[1]?.script).toContain('-e node_modules -e .next');
  });

  it('runs one sandbox at a time', async () => {
    const { sandboxes } = recorder();
    const first = await sandboxes.start('run-1');
    await expect(sandboxes.start('run-2')).rejects.toThrow(
      'could not start sandbox pageagents-run-2: pageagents-run-1 is still running',
    );
    await sandboxes.stop(first);
    await expect(sandboxes.start('run-2')).resolves.toMatchObject({ name: 'pageagents-run-2' });
  });

  it("kills the run's processes on stop, and ignores a sandbox it isn't running", async () => {
    const { calls, sandboxes } = recorder();
    const sandbox = await sandboxes.start('run-1');
    calls.length = 0;

    await sandboxes.stop(sandbox);
    await sandboxes.stop(sandbox);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ asUser: false });
    expect(calls[0]?.script).toContain('pkill');
  });

  it('reports a reset that fails, with its stderr', async () => {
    const { sandboxes } = recorder(/git reset/);
    await expect(sandboxes.start('run-1')).rejects.toThrow(
      'could not start sandbox pageagents-run-1: git: not a repo',
    );
    // Nothing is held, so the next start tries again.
    const reaped = await sandboxes.reap();
    expect(reaped.failed.map((f) => f.name)).toEqual(['workspace']);
    expect(reaped.failed[0]?.error).toBeInstanceOf(Error);
  });

  it('reaps by cleaning the workspace', async () => {
    const { calls, sandboxes } = recorder();
    await expect(sandboxes.reap()).resolves.toEqual({ removed: [], failed: [] });
    expect(calls.map((c) => c.asUser)).toEqual([false, true]);
  });
});
