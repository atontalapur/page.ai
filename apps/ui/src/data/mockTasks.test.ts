import { describe, expect, it } from 'vitest';

import { getAgentStatus, type AgentTask, type TaskStatus } from './mockTasks';

function task(agentId: string, status: TaskStatus): AgentTask {
  return {
    id: `TASK-${agentId}-${status}`,
    title: 'Investigate',
    instructions: '',
    agentId,
    incidentId: null,
    priority: 'Medium',
    status,
    createdAt: '2026-11-20T10:00:00Z',
    startedAt: null,
    completedAt: null,
  };
}

describe('getAgentStatus', () => {
  it('keeps the static status when the agent has no tasks', () => {
    expect(getAgentStatus({ id: 'AG-004', status: 'Failed' }, [])).toBe('Failed');
    expect(getAgentStatus({ id: 'AG-003', status: 'Idle' }, [task('AG-001', 'Running')])).toBe(
      'Idle',
    );
  });

  it.each<TaskStatus>(['Running', 'Queued', 'Awaiting Approval'])(
    'reports Running for an agent with a %s task',
    (status) => {
      expect(getAgentStatus({ id: 'AG-003', status: 'Idle' }, [task('AG-003', status)])).toBe(
        'Running',
      );
    },
  );

  it('reports Idle once every task is finished', () => {
    const tasks = [task('AG-001', 'Completed'), task('AG-001', 'Failed')];

    expect(getAgentStatus({ id: 'AG-001', status: 'Running' }, tasks)).toBe('Idle');
  });
});
