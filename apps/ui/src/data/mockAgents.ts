
export type AgentStatus = 'Running' | 'Idle' | 'Failed';

export type AgentType =
  | 'Diagnostic'
  | 'Fix'
  | 'Review'
  | 'Monitoring';

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  status: AgentStatus;
  description: string;
  currentIncident: string | null;
  tasksCompleted: number;
  lastActive: string;
}

export const mockAgents: Agent[] = [
  {
    id: 'AG-001',
    name: 'Diagnostic Agent',
    type: 'Diagnostic',
    status: 'Running',
    description:
      'Investigates incidents, analyzes stack traces, and identifies possible root causes.',
    currentIncident: 'INC-001',
    tasksCompleted: 42,
    lastActive: '2026-11-22T10:15:00',
  },
  {
    id: 'AG-002',
    name: 'Fix Agent',
    type: 'Fix',
    status: 'Running',
    description:
      'Generates proposed code changes and prepares fixes for review.',
    currentIncident: 'INC-003',
    tasksCompleted: 28,
    lastActive: '2026-11-22T09:10:00',
  },
  {
    id: 'AG-003',
    name: 'Review Agent',
    type: 'Review',
    status: 'Idle',
    description:
      'Reviews proposed fixes, checks code quality, and evaluates test results.',
    currentIncident: null,
    tasksCompleted: 35,
    lastActive: '2026-11-21T14:20:00',
  },
  {
    id: 'AG-004',
    name: 'Monitoring Agent',
    type: 'Monitoring',
    status: 'Failed',
    description:
      'Monitors application events and identifies unusual error patterns.',
    currentIncident: null,
    tasksCompleted: 19,
    lastActive: '2026-11-21T11:30:00',
  },
];

export function getAgentById(id: string): Agent | undefined {
  return mockAgents.find((agent) => agent.id === id);
}
