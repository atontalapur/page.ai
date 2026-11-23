import { describe, expect, it } from 'vitest';

import { describeApproval } from './approvalText';

const live = {
  id: 'dep-live',
  status: 'SUCCESS',
  commit: 'b1c2d3e4f5',
  createdAt: '2026-11-20T10:00:00.000Z',
};
const good = {
  id: 'dep-good',
  status: 'REMOVED',
  commit: 'a9b8c7d6e5',
  createdAt: '2026-11-19T10:00:00.000Z',
};

describe('describeApproval', () => {
  it('says which setting a change sets, and when it applies', () => {
    expect(
      describeApproval({
        action: 'ops.setConfig',
        args: { tool: 'ops.setConfig', key: 'SHIPPING_FLAT_CENTS', value: '500' },
      }),
    ).toEqual({
      title: 'Change a setting on the live app',
      detail: 'Set SHIPPING_FLAT_CENTS to "500". The app loads it on its next restart.',
    });
    expect(describeApproval({ action: 'ops.setConfig', args: {} }).detail).toBe(
      'Set a setting to "". The app loads it on its next restart.',
    );
  });

  it('says which override a drop removes', () => {
    const { detail } = describeApproval({
      action: 'ops.deleteConfig',
      args: { key: 'SHIPPING_FLAT_CENTS' },
    });
    expect(detail).toMatch(/^Remove the override on SHIPPING_FLAT_CENTS,/);
  });

  it('says what a restart drops', () => {
    const { title, detail } = describeApproval({
      action: 'ops.restart',
      args: { tool: 'ops.restart' },
    });
    expect(title).toBe('Restart the live app');
    expect(detail).toContain('Requests in flight');
  });

  it('names the deployment a rollback replaces and the one it deploys again', () => {
    const { title, detail } = describeApproval({
      action: 'ops.rollback',
      args: { tool: 'ops.rollback', to: 'dep-good', from: 'dep-live', live, rollBackTo: good },
    });
    expect(title).toBe('Roll back the live app');
    expect(detail).toMatch(
      /^Replace the live deployment dep-live \(commit b1c2d3e, deployed .+\) with the earlier deployment dep-good \(commit a9b8c7d, deployed .+\)\.$/,
    );
  });

  it('gives what it has of a rollback without its plan', () => {
    expect(
      describeApproval({ action: 'ops.rollback', args: { to: 'dep-good', rollBackTo: 'odd' } })
        .detail,
    ).toBe('Deploy dep-good again in place of the live deployment.');
    expect(
      describeApproval({
        action: 'ops.rollback',
        args: { from: 'dep-live', to: 'dep-good', rollBackTo: { createdAt: 'not a date' } },
      }).detail,
    ).toBe('Replace the live deployment dep-live with the earlier deployment dep-good.');
    expect(describeApproval({ action: 'ops.rollback', args: {} }).detail).toBe(
      'Deploy an earlier deployment again in place of the live deployment.',
    );
  });

  it('shows the arguments of an action it does not know', () => {
    expect(
      describeApproval({ action: 'ops.scale', args: { tool: 'ops.scale', replicas: 3 } }),
    ).toEqual({ title: 'Run ops.scale on the live app', detail: '{"replicas":3}' });
  });
});
