import { describe, expect, it } from 'vitest';
import { FakeDeployer } from '../deploy/fake-deployer.ts';
import { FakeOps } from '../ops/fake-ops.ts';
import { OpsHostTools } from '../ops/host-tools.ts';
import { combineHostTools, hostToolsFor } from './combine.ts';
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

describe('hostToolsFor', () => {
  const ops = new OpsHostTools({ ops: new FakeOps() });

  it('gives the GitHub tools from Tier 2 and the ops tools from Tier 3', () => {
    expect(hostToolsFor(1, { github, ops })).toBeUndefined();
    const tier2 = hostToolsFor(2, { github, ops });
    expect(tier2?.handles?.('git.pushBranch')).toBe(true);
    expect(tier2?.handles?.('ops.restart')).toBe(false);
    const tier3 = hostToolsFor(3, { github, ops });
    expect(tier3?.handles?.('git.pushBranch')).toBe(true);
    expect(tier3?.handles?.('ops.restart')).toBe(true);
  });

  it('gives nothing when no part is set up', () => {
    expect(hostToolsFor(3, {})).toBeUndefined();
    expect(hostToolsFor(3, { ops })?.handles?.('github.openPr')).toBe(false);
  });

  it('gives the rollback tools only with a deployer, so execute() refuses them otherwise', () => {
    expect(hostToolsFor(3, { ops })?.handles?.('ops.rollback')).toBe(false);
    const deploys = new OpsHostTools({ ops: new FakeOps(), deployer: new FakeDeployer() });
    const tier3 = hostToolsFor(3, { github, ops: deploys });
    expect(tier3?.handles?.('ops.planRollback')).toBe(true);
    expect(tier3?.handles?.('ops.rollback')).toBe(true);
    expect(hostToolsFor(2, { github, ops: deploys })?.handles?.('ops.rollback')).toBe(false);
  });
});
