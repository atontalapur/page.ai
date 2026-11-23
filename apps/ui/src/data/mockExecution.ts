import type { TaskStatus } from './mockTasks';

export type ExecutionStepId = 'received' | 'analysis' | 'fix' | 'tests' | 'approval';

export type ExecutionStepStatus = 'completed' | 'current' | 'pending' | 'failed';

export interface ExecutionStep {
  id: ExecutionStepId;
  title: string;
  description: string;
  status: ExecutionStepStatus;
}

export interface DiffLine {
  type: 'context' | 'added' | 'removed';
  text: string;
}

export interface ExecutionLog {
  step: ExecutionStepId;
  text: string;
}

export interface ExecutionTest {
  name: string;
  passed: boolean;
}

export interface IncidentExecution {
  incidentId: string;
  files: string[];
  diff: DiffLine[];
  logs: ExecutionLog[];
  tests: ExecutionTest[];
}

export const mockExecutions: IncidentExecution[] = [
  {
    incidentId: 'INC-001',
    files: ['src/db/connection.ts', 'src/services/users.ts', 'src/config/database.ts'],
    diff: [
      { type: 'context', text: 'async function connectDatabase() {' },
      { type: 'removed', text: '-  const timeout = 5000;' },
      { type: 'added', text: '+  const timeout = 10000;' },
      { type: 'context', text: '   return createConnection({ timeout });' },
      { type: 'context', text: '}' },
    ],
    logs: [
      { step: 'received', text: '[10:15:01] INFO  Investigation started' },
      { step: 'analysis', text: '[10:15:03] INFO  Reading incident stack trace' },
      { step: 'analysis', text: '[10:15:05] INFO  Inspecting database connection module' },
      { step: 'analysis', text: '[10:15:08] INFO  Possible timeout configuration issue detected' },
      { step: 'fix', text: '[10:15:12] INFO  Generating proposed patch' },
      { step: 'tests', text: '[10:15:16] INFO  Running validation tests' },
      { step: 'tests', text: '[10:15:20] INFO  Tests completed' },
      { step: 'approval', text: '[10:15:21] INFO  Awaiting human approval' },
    ],
    tests: [
      { name: 'Database connection initializes', passed: true },
      { name: 'Connection retry behavior', passed: true },
      { name: 'Timeout configuration validation', passed: true },
      { name: 'Connection recovery under load', passed: false },
    ],
  },
  {
    incidentId: 'INC-002',
    files: ['src/routes/users.ts', 'src/services/users.ts', 'src/db/queries/users.sql'],
    diff: [
      { type: 'context', text: 'export async function listUsers(db: Database) {' },
      { type: 'removed', text: '-  const users = await db.query(selectAllUsers);' },
      { type: 'added', text: '+  const users = await db.query(selectUsersPage, { limit: 50 });' },
      { type: 'context', text: '   return users.map(toUserDto);' },
      { type: 'context', text: '}' },
    ],
    logs: [
      { step: 'received', text: '[09:50:02] INFO  Investigation started' },
      { step: 'analysis', text: '[09:50:04] INFO  Profiling GET /api/users' },
      { step: 'analysis', text: '[09:50:09] INFO  Unbounded query returns every user row' },
      { step: 'fix', text: '[09:50:14] INFO  Generating pagination patch' },
      { step: 'tests', text: '[09:50:19] INFO  Running validation tests' },
      { step: 'tests', text: '[09:50:25] INFO  Tests completed' },
      { step: 'approval', text: '[09:50:26] INFO  Awaiting human approval' },
    ],
    tests: [
      { name: 'Users endpoint returns first page', passed: true },
      { name: 'Users endpoint responds under 200 ms', passed: true },
    ],
  },
  {
    incidentId: 'INC-003',
    files: ['src/workers/task.ts', 'src/workers/queue.ts'],
    diff: [
      { type: 'context', text: 'process(job: Job) {' },
      { type: 'removed', text: '-  this.results.push(job.payload);' },
      { type: 'added', text: '+  this.emit("result", job.payload);' },
      { type: 'context', text: '   this.queue.ack(job.id);' },
      { type: 'context', text: '}' },
    ],
    logs: [
      { step: 'received', text: '[16:10:01] INFO  Investigation started' },
      { step: 'analysis', text: '[16:10:04] INFO  Sampling worker heap snapshots' },
      { step: 'analysis', text: '[16:10:11] INFO  Worker.results grows with every processed job' },
      { step: 'fix', text: '[16:10:15] INFO  Generating proposed patch' },
      { step: 'tests', text: '[16:10:20] INFO  Running validation tests' },
      { step: 'tests', text: '[16:10:31] INFO  Tests completed' },
      { step: 'approval', text: '[16:10:32] INFO  Awaiting human approval' },
    ],
    tests: [
      { name: 'Worker processes queued jobs', passed: true },
      { name: 'Heap stays flat over 10,000 jobs', passed: true },
      { name: 'Results are emitted to listeners', passed: true },
    ],
  },
  {
    incidentId: 'INC-004',
    files: ['src/auth/middleware.ts', 'src/auth/tokens.ts'],
    diff: [
      { type: 'context', text: 'export function verify(token: string) {' },
      { type: 'removed', text: '-  return jwt.verify(token, secret);' },
      { type: 'added', text: '+  return jwt.verify(token, secret, { clockTolerance: 30 });' },
      { type: 'context', text: '}' },
    ],
    logs: [
      { step: 'received', text: '[14:00:01] INFO  Review started' },
      { step: 'analysis', text: '[14:00:05] INFO  Checking token expiry handling' },
      { step: 'fix', text: '[14:00:09] INFO  Generating proposed patch' },
      { step: 'tests', text: '[14:00:13] INFO  Running validation tests' },
      { step: 'tests', text: '[14:00:18] INFO  Tests completed' },
      { step: 'approval', text: '[14:00:19] INFO  Awaiting human approval' },
    ],
    tests: [
      { name: 'Expired token is rejected', passed: true },
      { name: 'Token within clock tolerance is accepted', passed: false },
    ],
  },
];

export function getExecutionByIncident(incidentId: string): IncidentExecution | undefined {
  return mockExecutions.find((execution) => execution.incidentId === incidentId);
}

const stepTemplates: Omit<ExecutionStep, 'status'>[] = [
  {
    id: 'received',
    title: 'Incident received',
    description: 'Agent received the assigned investigation.',
  },
  {
    id: 'analysis',
    title: 'Root cause analysis',
    description: 'Analyzed stack traces and relevant source files.',
  },
  {
    id: 'fix',
    title: 'Generate proposed fix',
    description: 'Prepared a candidate code change.',
  },
  {
    id: 'tests',
    title: 'Run tests',
    description: 'Executed validation tests against the proposed fix.',
  },
  {
    id: 'approval',
    title: 'Human approval',
    description: 'Waiting for a reviewer to approve or reject the fix.',
  },
];

// How many steps are done for each task status, and which step is in progress.
const progressByStatus: Record<TaskStatus, { completed: number; current: number | null }> = {
  Queued: { completed: 0, current: null },
  Running: { completed: 2, current: 2 },
  'Awaiting Approval': { completed: 4, current: 4 },
  Completed: { completed: 5, current: null },
  Failed: { completed: 4, current: null },
};

const approvalDescriptions: Partial<Record<TaskStatus, string>> = {
  Queued: 'A reviewer will approve or reject the fix once tests have run.',
  Running: 'A reviewer will approve or reject the fix once tests have run.',
  Completed: 'A reviewer approved the fix.',
  Failed: 'A reviewer rejected the fix.',
};

export function getExecutionSteps(status: TaskStatus): ExecutionStep[] {
  const progress = progressByStatus[status];

  return stepTemplates.map((template, index) => {
    const stepStatus: ExecutionStepStatus =
      index < progress.completed
        ? 'completed'
        : index === progress.current
          ? 'current'
          : status === 'Failed' && template.id === 'approval'
            ? 'failed'
            : 'pending';

    return {
      ...template,
      description:
        template.id === 'approval'
          ? (approvalDescriptions[status] ?? template.description)
          : template.description,
      status: stepStatus,
    };
  });
}

/** True once the given step has been reached (completed, in progress or failed). */
export function hasReachedStep(steps: ExecutionStep[], stepId: ExecutionStepId): boolean {
  return steps.some((step) => step.id === stepId && step.status !== 'pending');
}

/** True once the given step has finished. */
export function hasCompletedStep(steps: ExecutionStep[], stepId: ExecutionStepId): boolean {
  return steps.some((step) => step.id === stepId && step.status === 'completed');
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatTestSummary(tests: ExecutionTest[]): string {
  const passed = tests.filter((test) => test.passed).length;
  const failed = tests.length - passed;

  return `${countLabel(passed, 'test')} passed, ${countLabel(failed, 'test')} failed.`;
}
