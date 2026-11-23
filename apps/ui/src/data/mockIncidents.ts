
export type IncidentSeverity = 'Critical' | 'High' | 'Medium' | 'Low';

export type IncidentStatus =
  | 'Open'
  | 'Investigating'
  | 'Awaiting Approval'
  | 'Resolved';

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  source: string;
  assignedAgent: string | null;
  occurrences: number;
  createdAt: string;
  updatedAt: string;
  stackTrace: string;
}

export const mockIncidents: Incident[] = [
  {
    id: 'INC-001',
    title: 'Database connection timeout',
    description:
      'The application failed to establish a PostgreSQL connection within the configured timeout.',
    severity: 'Critical',
    status: 'Investigating',
    source: 'PostHog',
    assignedAgent: 'AG-001',
    occurrences: 24,
    createdAt: '2026-11-22T09:30:00',
    updatedAt: '2026-11-22T10:15:00',
    stackTrace:
      'Error: Connection timeout\n  at Database.connect (src/db/connection.ts:42)\n  at UserService.findAll (src/services/users.ts:18)',
  },
  {
    id: 'INC-002',
    title: 'API response latency',
    description:
      'The users endpoint is responding slower than expected.',
    severity: 'Medium',
    status: 'Open',
    source: 'PostHog',
    assignedAgent: null,
    occurrences: 12,
    createdAt: '2026-11-22T08:20:00',
    updatedAt: '2026-11-22T09:45:00',
    stackTrace:
      'Warning: Slow API response\n  at GET /api/users',
  },
  {
    id: 'INC-003',
    title: 'Memory leak in background worker',
    description:
      'Memory usage increases continuously during background processing.',
    severity: 'High',
    status: 'Awaiting Approval',
    source: 'PostHog',
    assignedAgent: 'AG-002',
    occurrences: 18,
    createdAt: '2026-11-21T16:00:00',
    updatedAt: '2026-11-22T09:10:00',
    stackTrace:
      'Error: Heap out of memory\n  at Worker.process (src/workers/task.ts:75)',
  },
  {
    id: 'INC-004',
    title: 'Authentication token expired',
    description:
      'An expired authentication token caused repeated authorization failures.',
    severity: 'Low',
    status: 'Resolved',
    source: 'PostHog',
    assignedAgent: 'AG-003',
    occurrences: 7,
    createdAt: '2026-11-21T11:30:00',
    updatedAt: '2026-11-21T14:20:00',
    stackTrace:
      'Error: JWT expired\n  at AuthMiddleware.verify (src/auth/middleware.ts:31)',
  },
  {
    id: 'INC-005',
    title: 'Payment processing failure',
    description:
      'Payment requests are failing because of an unexpected server error.',
    severity: 'Critical',
    status: 'Open',
    source: 'PostHog',
    assignedAgent: null,
    occurrences: 31,
    createdAt: '2026-11-22T07:10:00',
    updatedAt: '2026-11-22T10:30:00',
    stackTrace:
      'Error: Internal server error\n  at PaymentService.process (src/payments/service.ts:102)',
  },
];

export function getIncidentById(id: string): Incident | undefined {
  return mockIncidents.find((incident) => incident.id === id);
}
