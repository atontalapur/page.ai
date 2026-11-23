import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  formatTaskId,
  getActiveTask,
  getHighestTaskNumber,
  getTasksByAgent,
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
  getActiveAgentTask: (agentId: string) => AgentTask | undefined;
}

const TaskContext = createContext<TaskContextType | undefined>(undefined);

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<AgentTask[]>(initialMockTasks);

  // Display ids continue after the highest mock id. A counter works in every
  // context, unlike crypto.randomUUID, which needs HTTPS or localhost.
  const lastTaskNumber = useRef(getHighestTaskNumber(initialMockTasks));

  const createTask = useCallback((input: CreateTaskInput): AgentTask => {
    lastTaskNumber.current += 1;

    const task: AgentTask = {
      id: formatTaskId(lastTaskNumber.current),
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
  }, []);

  const updateTaskStatus = useCallback((taskId: string, status: TaskStatus) => {
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
  }, []);

  const getAgentTasks = useCallback(
    (agentId: string): AgentTask[] => getTasksByAgent(tasks, agentId),
    [tasks],
  );

  const getActiveAgentTask = useCallback(
    (agentId: string): AgentTask | undefined => getActiveTask(tasks, agentId),
    [tasks],
  );

  const value = useMemo(
    () => ({ tasks, createTask, updateTaskStatus, getAgentTasks, getActiveAgentTask }),
    [tasks, createTask, updateTaskStatus, getAgentTasks, getActiveAgentTask],
  );

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export function useTasks(): TaskContextType {
  const context = useContext(TaskContext);

  if (!context) {
    throw new Error('useTasks must be used inside TaskProvider');
  }

  return context;
}
