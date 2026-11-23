import type { HostToolCall } from '@page/toolkit';
import { describe, expect, it } from 'vitest';
import { approvalArgs, autoApprovals } from './approvals.ts';

const restart: HostToolCall = { kind: 'host_tool', tool: 'ops.restart' };
const rollback: HostToolCall = { kind: 'host_tool', tool: 'ops.rollback', to: 'good' };
const live = { id: 'bad', status: 'SUCCESS', commit: 'b1', createdAt: '2026-11-20T10:00:00Z' };
const good = { id: 'good', status: 'REMOVED', commit: 'g1', createdAt: '2026-11-19T10:00:00Z' };

describe('autoApprovals', () => {
  it('approves every call of every run as who it was given', async () => {
    const approve = autoApprovals('AUTO_APPROVE_OPS').forRun({
      runId: 'r',
      signal: new AbortController().signal,
      args: () => ({}),
    });
    await expect(approve(restart, { timeoutMs: 1 })).resolves.toEqual({
      approved: true,
      by: 'AUTO_APPROVE_OPS',
    });
  });
});

describe('approvalArgs', () => {
  it('is the call as its step logs it', () => {
    const set: HostToolCall = { kind: 'host_tool', tool: 'ops.setConfig', key: 'K', value: '5' };
    expect(approvalArgs(set, undefined)).toEqual({ tool: 'ops.setConfig', key: 'K', value: '5' });
    expect(approvalArgs(restart, { plannedRollback: { live, rollBackTo: good } })).toEqual({
      tool: 'ops.restart',
    });
  });

  it('names what a rollback replaces, from the last plan', () => {
    expect(approvalArgs(rollback, { plannedRollback: { live, rollBackTo: good } })).toEqual({
      tool: 'ops.rollback',
      to: 'good',
      from: 'bad',
      live,
      rollBackTo: good,
    });
  });

  it('gives only the target without a plan, which the tool will refuse anyway', () => {
    expect(approvalArgs(rollback, { plannedRollback: null })).toEqual({
      tool: 'ops.rollback',
      to: 'good',
    });
    expect(approvalArgs(rollback, undefined)).toEqual({ tool: 'ops.rollback', to: 'good' });
  });
});
