export type TaskStatus =
  | 'Queued'
  | 'Running'
  | 'Awaiting Approval'
  | 'Completed'
  | 'Failed';

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
    instructions:
      'Analyze the connection timeout and identify the root cause.',
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
    instructions:
      'Inspect the background worker and propose a fix for the memory leak.',
    agentId: 'AG-002',
    incidentId: 'INC-003',
    priority: 'High',
    status: 'Awaiting Approval',
    createdAt: '2026-11-21T16:00:00',
    startedAt: '2026-11-21T16:10:00',
    completedAt: null,
  },
];

export function getTasksByAgent(
  tasks: AgentTask[],
  agentId: string
): AgentTask[] {
  return tasks.filter((task) => task.agentId === agentId);
}

export function getTaskById(
  tasks: AgentTask[],
  taskId: string
): AgentTask | undefined {
  return tasks.find((task) => task.id === taskId);
}
