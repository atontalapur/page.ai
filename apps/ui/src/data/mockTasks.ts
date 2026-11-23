import type { AgentStatus } from './mockAgents';

export type TaskStatus = 'Queued' | 'Running' | 'Awaiting Approval' | 'Completed' | 'Failed';

export type TaskPriority = 'Critical' | 'High' | 'Medium' | 'Low';

export interface AgentTask {
  id: string;
  title: string;
  instructions: string;
  agentId: string;
  incidentId: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export const initialMockTasks: AgentTask[] = [
  {
    id: 'TASK-001',
    title: 'Investigate database connection timeout',
    instructions: 'Analyze the connection timeout and identify the root cause.',
    agentId: 'AG-001',
    incidentId: 'INC-001',
    priority: 'Critical',
    status: 'Running',
    createdAt: '2026-11-22T09:30:00',
    startedAt: '2026-11-22T09:35:00',
    completedAt: null,
  },
  {
    id: 'TASK-002',
    title: 'Generate fix for memory leak',
    instructions: 'Inspect the background worker and propose a fix for the memory leak.',
    agentId: 'AG-002',
    incidentId: 'INC-003',
    priority: 'High',
    status: 'Awaiting Approval',
    createdAt: '2026-11-21T16:00:00',
    startedAt: '2026-11-21T16:10:00',
    completedAt: null,
  },
];

const TASK_ID_PATTERN = /^TASK-(\d+)$/;

export function formatTaskId(taskNumber: number): string {
  return `TASK-${String(taskNumber).padStart(3, '0')}`;
}

export function getHighestTaskNumber(tasks: AgentTask[]): number {
  return tasks.reduce((highest, task) => {
    const match = TASK_ID_PATTERN.exec(task.id);

    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
}

export function getTasksByAgent(tasks: AgentTask[], agentId: string): AgentTask[] {
  return tasks.filter((task) => task.agentId === agentId);
}

const activeStatusOrder: TaskStatus[] = ['Running', 'Queued', 'Awaiting Approval'];

/**
 * The task an agent is working on: its first Running task, else its first
 * Queued task, else its first Awaiting Approval task.
 */
export function getActiveTask(tasks: AgentTask[], agentId: string): AgentTask | undefined {
  const agentTasks = getTasksByAgent(tasks, agentId);

  for (const status of activeStatusOrder) {
    const task = agentTasks.find((candidate) => candidate.status === status);

    if (task) {
      return task;
    }
  }

  return undefined;
}

/** The agent's most recently finished (Completed or Failed) task. */
export function getLatestFinishedTask(tasks: AgentTask[], agentId: string): AgentTask | undefined {
  return getTasksByAgent(tasks, agentId)
    .filter((task) => task.status === 'Completed' || task.status === 'Failed')
    .reduce<AgentTask | undefined>(
      (latest, task) =>
        !latest || (task.completedAt ?? '') >= (latest.completedAt ?? '') ? task : latest,
      undefined,
    );
}

/**
 * The agent's status as the list views show it. An agent with an active task
 * (Running, Queued or Awaiting Approval) is Running, one whose tasks are all
 * finished is Idle, and one with no tasks keeps its static status.
 */
export function getAgentStatus(
  agent: { id: string; status: AgentStatus },
  tasks: AgentTask[],
): AgentStatus {
  if (getActiveTask(tasks, agent.id)) {
    return 'Running';
  }

  return getTasksByAgent(tasks, agent.id).length > 0 ? 'Idle' : agent.status;
}
