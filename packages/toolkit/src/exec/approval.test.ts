import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { HOST_TOOL_TIERS } from '../policy/policy.ts';
import { APPROVAL_TOOLS, approvalGate, autoApprove, needsApproval } from './approval.ts';
import type { Approve, HostToolCall, HostToolName, HostTools } from './types.ts';

const log = pino({ enabled: false });
const restart: HostToolCall = { kind: 'host_tool', tool: 'ops.restart' };

describe('which host tools need a person', () => {
  it.each<[HostToolName, boolean]>([
    ['ops.setConfig', true],
    ['ops.deleteConfig', true],
    ['ops.restart', true],
    ['ops.rollback', true],
    ['ops.getConfig', false],
    ['ops.planRollback', false],
    ['git.pushBranch', false],
    ['github.openPr', false],
  ])('%s: %s', (tool, gated) => {
    expect(needsApproval(tool)).toBe(gated);
  });

  it('gates only Tier 3 tools', () => {
    for (const tool of APPROVAL_TOOLS) expect(HOST_TOOL_TIERS[tool]).toBe(3);
  });
});

describe('autoApprove', () => {
  it('approves every call as who it was given', async () => {
    await expect(autoApprove('eval')(restart, { timeoutMs: 1 })).resolves.toEqual({
      approved: true,
      by: 'eval',
    });
  });
});

describe('approvalGate', () => {
  /** A clock that moves `stepMs` each time it is read. */
  const clock = (stepMs: number) => {
    let at = 1_000;
    return () => (at += stepMs);
  };

  it('lets a call that needs no approval through without asking', async () => {
    const approve: Approve = () => Promise.reject(new Error('asked'));
    const read: HostToolCall = { kind: 'host_tool', tool: 'ops.getConfig' };
    expect(await approvalGate(read, { approve }, 1_000, log)).toBeUndefined();
  });

  it('asks no one for a call the host tools would refuse', async () => {
    const approve: Approve = () => Promise.reject(new Error('asked'));
    const hostTools: HostTools = {
      refusal: () => 'spent',
      run: () => Promise.resolve({ ok: false, output: 'spent' }),
    };
    expect(await approvalGate(restart, { approve, hostTools }, 1_000, log)).toBeUndefined();
  });

  it('asks host tools with no refusal check, and takes the wait off the time limit', async () => {
    const asked: number[] = [];
    const approve: Approve = (_call, { timeoutMs }) => {
      asked.push(timeoutMs);
      return Promise.resolve({ approved: true, by: 'ui:arjun' });
    };
    const hostTools: HostTools = { run: () => Promise.resolve({ ok: true, output: '' }) };
    const gate = await approvalGate(restart, { approve, hostTools }, 10_000, log, clock(4_000));
    expect(asked).toEqual([10_000]);
    expect(gate).toEqual({ timeoutMs: 6_000 });
  });

  it('leaves the call at least 1 ms when the approval took all of it', async () => {
    const gate = await approvalGate(
      restart,
      { approve: autoApprove('x') },
      1_000,
      log,
      clock(5_000),
    );
    expect(gate).toEqual({ timeoutMs: 1 });
  });

  it('refuses a rejected call with the reason', async () => {
    const approve: Approve = () => Promise.resolve({ approved: false, reason: 'no one decided' });
    expect(await approvalGate(restart, { approve }, 1_000, log)).toEqual({
      refusal: 'ops.restart was not approved: no one decided',
    });
  });

  it('refuses the call when the approver throws', async () => {
    const approve: Approve = () => Promise.reject(new Error('boom'));
    expect(await approvalGate(restart, { approve }, 1_000, log)).toEqual({
      refusal: 'ops.restart was not approved: asking for approval failed',
    });
  });
});
