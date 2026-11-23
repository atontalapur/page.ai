// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';

import { TaskProvider, useTasks } from './TaskContext';

function wrapper({ children }: { children: ReactNode }) {
  return <TaskProvider>{children}</TaskProvider>;
}

describe('TaskContext', () => {
  it('loads initial mock tasks', () => {
    const { result } = renderHook(() => useTasks(), {
      wrapper,
    });

    expect(result.current.tasks.length).toBeGreaterThan(0);
  });

  it('creates a new task', () => {
    const { result } = renderHook(() => useTasks(), {
      wrapper,
    });

    const initialCount = result.current.tasks.length;

    act(() => {
      result.current.createTask({
        title: 'Investigate API latency',
        instructions: 'Analyze slow API responses',
        agentId: 'AG-003',
        incidentId: 'INC-002',
        priority: 'High',
      });
    });

    expect(result.current.tasks).toHaveLength(initialCount + 1);

    const createdTask = result.current.tasks.at(-1);

    expect(createdTask?.title).toBe('Investigate API latency');
    expect(createdTask?.agentId).toBe('AG-003');
    expect(createdTask?.status).toBe('Queued');
  });

  it('updates a task status', () => {
    const { result } = renderHook(() => useTasks(), {
      wrapper,
    });

    let taskId = '';

    act(() => {
      const task = result.current.createTask({
        title: 'Test task',
        instructions: 'Test instructions',
        agentId: 'AG-001',
        incidentId: null,
        priority: 'Medium',
      });

      taskId = task.id;
    });

    act(() => {
      result.current.updateTaskStatus(taskId, 'Running');
    });

    const updatedTask = result.current.tasks.find(
      (task) => task.id === taskId
    );

    expect(updatedTask?.status).toBe('Running');
    expect(updatedTask?.startedAt).not.toBeNull();
  });

  it('retrieves tasks assigned to a specific agent', () => {
    const { result } = renderHook(() => useTasks(), {
      wrapper,
    });

    act(() => {
      result.current.createTask({
        title: 'Review incident',
        instructions: 'Review the proposed changes',
        agentId: 'AG-003',
        incidentId: 'INC-002',
        priority: 'High',
      });
    });

    const agentTasks = result.current.getAgentTasks('AG-003');

    expect(agentTasks.length).toBeGreaterThan(0);
    expect(
      agentTasks.every((task) => task.agentId === 'AG-003')
    ).toBe(true);
  });
});
