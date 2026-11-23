// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';

import { TaskProvider, useTasks } from './TaskContext';
import { initialMockTasks } from '../data/mockTasks';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

    const updatedTask = result.current.tasks.find((task) => task.id === taskId);

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
    expect(agentTasks.every((task) => task.agentId === 'AG-003')).toBe(true);
  });

  it('creates sequential display ids without crypto.randomUUID', () => {
    // Plain-HTTP pages on a non-localhost host have no crypto.randomUUID.
    vi.stubGlobal('crypto', {});

    const { result } = renderHook(() => useTasks(), {
      wrapper,
    });

    const input = {
      title: 'Investigate API latency',
      instructions: 'Analyze slow API responses',
      agentId: 'AG-003',
      incidentId: 'INC-002',
      priority: 'High' as const,
    };

    const ids: string[] = [];

    act(() => {
      ids.push(result.current.createTask(input).id);
      ids.push(result.current.createTask(input).id);
    });

    expect(initialMockTasks.map((task) => task.id)).toEqual(['TASK-001', 'TASK-002']);
    expect(ids).toEqual(['TASK-003', 'TASK-004']);
    expect(result.current.tasks.map((task) => task.id)).toEqual([
      'TASK-001',
      'TASK-002',
      'TASK-003',
      'TASK-004',
    ]);
  });

  it('picks the active task in Running, Awaiting Approval, Queued order', () => {
    const { result } = renderHook(() => useTasks(), {
      wrapper,
    });

    const input = {
      title: 'Review incident',
      instructions: 'Review the proposed changes',
      agentId: 'AG-003',
      incidentId: 'INC-002',
      priority: 'High' as const,
    };

    expect(result.current.getActiveAgentTask('AG-003')).toBeUndefined();
    expect(result.current.getActiveAgentTask('AG-002')?.status).toBe('Awaiting Approval');

    let awaitingId = '';
    let queuedId = '';
    let runningId = '';

    act(() => {
      awaitingId = result.current.createTask(input).id;
      queuedId = result.current.createTask(input).id;
      runningId = result.current.createTask(input).id;
    });

    expect(result.current.getActiveAgentTask('AG-003')?.id).toBe(awaitingId);

    act(() => {
      result.current.updateTaskStatus(awaitingId, 'Awaiting Approval');
    });

    // Work waiting on a human outranks work that hasn't started.
    expect(result.current.getActiveAgentTask('AG-003')?.id).toBe(awaitingId);

    act(() => {
      result.current.updateTaskStatus(runningId, 'Running');
    });

    expect(result.current.getActiveAgentTask('AG-003')?.id).toBe(runningId);

    act(() => {
      result.current.updateTaskStatus(runningId, 'Completed');
      result.current.updateTaskStatus(awaitingId, 'Completed');
    });

    expect(result.current.getActiveAgentTask('AG-003')?.id).toBe(queuedId);
  });

  it('keeps the context value stable until the tasks change', () => {
    const { result, rerender } = renderHook(() => useTasks(), {
      wrapper,
    });

    const first = result.current;

    rerender();

    expect(result.current).toBe(first);

    act(() => {
      result.current.updateTaskStatus('TASK-001', 'Awaiting Approval');
    });

    expect(result.current).not.toBe(first);
    expect(result.current.createTask).toBe(first.createTask);
    expect(result.current.updateTaskStatus).toBe(first.updateTaskStatus);
  });
});
