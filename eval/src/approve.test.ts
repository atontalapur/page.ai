import {
  execute,
  FakeOps,
  FakeRunner,
  InMemoryAuditSink,
  OpsHostTools,
  StepLog,
  type HostToolCall,
} from '@page/toolkit';
import { describe, expect, it } from 'vitest';
import { evalApprove } from './approve.ts';

describe('evalApprove', () => {
  it('runs every gated ops call at once, so an eval run never waits on a person', async () => {
    const ops = new FakeOps();
    const sink = new InMemoryAuditSink();
    const steps = new StepLog({ sink, issueId: 'i', runId: 'r' });
    const calls: HostToolCall[] = [
      { kind: 'host_tool', tool: 'ops.setConfig', key: 'SHIPPING_FLAT_CENTS', value: '500' },
      { kind: 'host_tool', tool: 'ops.deleteConfig', key: 'SHIPPING_FLAT_CENTS' },
      { kind: 'host_tool', tool: 'ops.restart' },
    ];
    for (const call of calls) {
      const result = await execute(call, {
        tier: 3,
        runner: new FakeRunner(),
        steps,
        hostTools: new OpsHostTools({ ops }),
        approve: evalApprove,
      });
      expect(result.ok).toBe(true);
    }
    expect(ops.calls).toEqual([
      'setConfig SHIPPING_FLAT_CENTS=500',
      'deleteConfig SHIPPING_FLAT_CENTS',
      'restart',
    ]);
    expect(sink.steps.every((s) => s.allowed)).toBe(true);
  });

  it('says the eval approved it', async () => {
    await expect(
      evalApprove({ kind: 'host_tool', tool: 'ops.restart' }, { timeoutMs: 1 }),
    ).resolves.toEqual({ approved: true, by: 'eval' });
  });
});
