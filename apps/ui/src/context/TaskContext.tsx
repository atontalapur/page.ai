import { createContext, useContext, useState, type ReactNode } from 'react';

import {
  initialMockTasks,
  type AgentTask,
  type TaskPriority,
  type TaskStatus,
} from '../data/mockTasks';

interface CreateTaskInput {
  title: string;
  instructions: string;
  agentId: string;
  incidentId: string | null;
  priority: TaskPriority;
}

interface TaskContextType {
  tasks: AgentTask[];
  createTask: (input: CreateTaskInput) => AgentTask;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  getAgentTasks: (agentId: string) => AgentTask[];
}

const TaskContext = createContext<TaskContextType | undefined>(undefined);

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<AgentTask[]>(initialMockTasks);

  const createTask = (input: CreateTaskInput): AgentTask => {
    const task: AgentTask = {
      id: `TASK-${crypto.randomUUID()}`,
      title: input.title,
      instructions: input.instructions,
      agentId: input.agentId,
      incidentId: input.incidentId,
      priority: input.priority,
      status: 'Queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };

    setTasks((previous) => [...previous, task]);

    return task;
  };

  const updateTaskStatus = (taskId: string, status: TaskStatus) => {
    setTasks((previous) =>
      previous.map((task) =>
        task.id === taskId
          ? {
              ...task,
              status,
              startedAt:
                status === 'Running' && !task.startedAt ? new Date().toISOString() : task.startedAt,
              completedAt:
                status === 'Completed' || status === 'Failed' ? new Date().toISOString() : null,
            }
          : task,
      ),
    );
  };

  const getAgentTasks = (agentId: string): AgentTask[] => {
    return tasks.filter((task) => task.agentId === agentId);
  };

  return (
    <TaskContext.Provider
      value={{
        tasks,
        createTask,
        updateTaskStatus,
        getAgentTasks,
      }}
    >
      {children}
    </TaskContext.Provider>
  );
}

export function useTasks(): TaskContextType {
  const context = useContext(TaskContext);

  if (!context) {
    throw new Error('useTasks must be used inside TaskProvider');
  }

  return context;
}
