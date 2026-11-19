import { describe, expect, it } from 'vitest';
import { FakeOps } from '../ops/fake-ops.ts';
import { OpsHostTools } from '../ops/host-tools.ts';
import { combineHostTools } from './combine.ts';
import type { HostToolCall, HostTools } from './types.ts';

const github: HostTools = {
  handles: (tool) => tool === 'git.pushBranch' || tool === 'github.openPr',
  run: (call) => Promise.resolve({ ok: true, output: `github ran ${call.tool}` }),
};

describe('combineHostTools', () => {
  it('sends each call to the part that handles it', async () => {
    const ops = new FakeOps();
    const tools = combineHostTools(github, new OpsHostTools({ ops }));
    const push: HostToolCall = { kind: 'host_tool', tool: 'git.pushBranch', message: 'm' };
    expect(await tools.run(push, 1000)).toEqual({ ok: true, output: 'github ran git.pushBranch' });
    expect((await tools.run({ kind: 'host_tool', tool: 'ops.restart' }, 1000)).ok).toBe(true);
    expect(ops.calls).toEqual(['restart']);
  });

  it('handles only what some part handles', async () => {
    const tools = combineHostTools(github);
    expect(tools.handles?.('github.openPr')).toBe(true);
    expect(tools.handles?.('ops.restart')).toBe(false);
    expect(await tools.run({ kind: 'host_tool', tool: 'ops.restart' }, 1000)).toEqual({
      ok: false,
      output: 'ops.restart is not set up on this node',
    });
  });
});
