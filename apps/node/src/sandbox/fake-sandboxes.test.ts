import { FakeRunner } from '@page/toolkit';
import { describe, expect, it } from 'vitest';
import { FakeSandboxes } from './fake-sandboxes.ts';

describe('FakeSandboxes', () => {
  it('tracks which sandboxes are running', async () => {
    const sandboxes = new FakeSandboxes();
    const a = await sandboxes.start('a');
    await sandboxes.start('b');
    await sandboxes.stop(a);
    await sandboxes.stop(a);
    expect(sandboxes.stopped).toEqual(['pageagents-a']);
    expect(sandboxes.running).toEqual(['pageagents-b']);
  });

  it('answers commands with the responder', async () => {
    const sandboxes = new FakeSandboxes(() => FakeRunner.exited(3, 'out'));
    const { runner, name } = await sandboxes.start('a');
    expect(await runner.run({ command: 'ls', timeoutMs: 1 })).toMatchObject({ exitCode: 3 });
    expect(sandboxes.runners.get(name)?.requests).toHaveLength(1);
  });

  it('fails one start when asked to', async () => {
    const sandboxes = new FakeSandboxes();
    sandboxes.failStart = true;
    await expect(sandboxes.start('a')).rejects.toThrow(/image not found/);
    await expect(sandboxes.start('a')).resolves.toMatchObject({ name: 'pageagents-a' });
  });
});
