import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Circle,
  Clock3,
  FileCode2,
  GitCompare,
  Terminal,
  TestTube2,
  XCircle,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@page/design-system/components/ui/card';
import { Badge } from '@page/design-system/components/ui/badge';
import { Button } from '@page/design-system/components/ui/button';

import { getAgentById } from '../data/mockAgents';
import { getIncidentById } from '../data/mockIncidents';
import {
  formatTestSummary,
  getExecutionByIncident,
  getExecutionSteps,
  hasCompletedStep,
  hasReachedStep,
  type ExecutionStepStatus,
} from '../data/mockExecution';
import { getLatestFinishedTask, type AgentTask } from '../data/mockTasks';
import { useTasks } from '../context/TaskContext';

type ReviewStatus = 'Pending' | 'Approved' | 'Rejected';
type WorkspaceTab = 'changes' | 'logs' | 'tests';

const reviewStatusByTaskStatus: Partial<Record<AgentTask['status'], ReviewStatus>> = {
  'Awaiting Approval': 'Pending',
  Completed: 'Approved',
  Failed: 'Rejected',
};

const stepStatusLabels: Record<ExecutionStepStatus, string> = {
  completed: 'Completed',
  current: 'In progress',
  pending: 'Pending',
  failed: 'Failed',
};

export default function AgentWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const agentId = id ?? '';

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('changes');

  const { tasks, getAgentTasks, getActiveAgentTask, updateTaskStatus } = useTasks();

  const agentTasks = getAgentTasks(agentId);

  const agent = id ? getAgentById(id) : undefined;

  // The workspace follows the agent's active task, then its latest finished
  // task. The static agent data is only used when the agent has no tasks.
  const activeTask = getActiveAgentTask(agentId);
  const workspaceTask = activeTask ?? getLatestFinishedTask(tasks, agentId);

  const incidentId = workspaceTask ? workspaceTask.incidentId : (agent?.currentIncident ?? null);
  const incident = incidentId ? getIncidentById(incidentId) : undefined;
  const execution = incident ? getExecutionByIncident(incident.id) : undefined;

  const agentStatus = activeTask ? activeTask.status : workspaceTask ? 'Idle' : agent?.status;

  // Without a task, a static current incident is treated as work in progress.
  const executionSteps = getExecutionSteps(workspaceTask?.status ?? 'Running');
  const visibleLogs = execution?.logs.filter((log) => hasReachedStep(executionSteps, log.step));

  const reviewTask =
    agentTasks.find((task) => task.status === 'Awaiting Approval') ??
    (workspaceTask && workspaceTask.status in reviewStatusByTaskStatus ? workspaceTask : undefined);
  const reviewStatus = reviewTask ? reviewStatusByTaskStatus[reviewTask.status] : undefined;
  const reviewExecution = reviewTask?.incidentId
    ? getExecutionByIncident(reviewTask.incidentId)
    : undefined;

  if (!agent) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-bold">Agent not found</h2>
        <p className="text-sm text-muted-foreground">The requested agent does not exist.</p>
        <Link to="/agents" className="text-sm text-primary hover:underline">
          Back to Agents
        </Link>
      </div>
    );
  }

  const tabs: { id: WorkspaceTab; label: string }[] = [
    { id: 'changes', label: 'Code Changes' },
    { id: 'logs', label: 'Execution Logs' },
    { id: 'tests', label: 'Test Results' },
  ];

  return (
    <div className="min-w-0 space-y-6">
      {/* Back navigation */}
      <Link
        to="/agents"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Agents
      </Link>

      {/* Workspace heading */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Bot className="size-6 text-primary" />
          </div>

          <div className="min-w-0">
            <h2 className="text-2xl font-bold tracking-tight">{agent.name}</h2>
            <p className="text-sm text-muted-foreground">{agent.id} · Agent Workspace</p>
          </div>
        </div>

        <Badge variant="outline">{agentStatus}</Badge>
      </div>

      {/* Agent Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Current Incident</CardTitle>
          </CardHeader>
          <CardContent>
            {incident ? (
              <Link
                to={`/incidents/${incident.id}`}
                className="font-semibold text-primary hover:underline"
              >
                {incident.id}
              </Link>
            ) : (
              <p className="font-semibold">No active incident</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {incident?.title ?? 'No investigation assigned'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tasks Completed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{agent.tasksCompleted}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Last Active</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-semibold">{new Date(agent.lastActive).toLocaleString()}</p>
          </CardContent>
        </Card>
      </div>

      {/* Assigned Tasks */}
      <Card>
        <CardHeader>
          <CardTitle>Assigned Tasks ({agentTasks.length})</CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          {agentTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks assigned to this agent.</p>
          ) : (
            agentTasks.map((task) => (
              <div key={task.id} className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-semibold">{task.title}</h3>
                    <p className="text-xs text-muted-foreground">{task.id}</p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{task.priority}</Badge>
                    <Badge variant="outline">{task.status}</Badge>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">{task.instructions}</p>

                {task.incidentId && (
                  <Link
                    to={`/incidents/${task.incidentId}`}
                    className="block text-sm text-primary hover:underline"
                  >
                    Related Incident: {task.incidentId}
                  </Link>
                )}

                <p className="text-xs text-muted-foreground">
                  Created: {new Date(task.createdAt).toLocaleString()}
                </p>

                {task.status === 'Queued' && (
                  <Button size="sm" onClick={() => updateTaskStatus(task.id, 'Running')}>
                    Start Task
                  </Button>
                )}

                {task.status === 'Running' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => updateTaskStatus(task.id, 'Awaiting Approval')}
                  >
                    Mark Awaiting Approval
                  </Button>
                )}

                {task.status === 'Awaiting Approval' && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => updateTaskStatus(task.id, 'Completed')}>
                      <CheckCircle2 className="mr-2 size-4" />
                      Approve
                    </Button>

                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => updateTaskStatus(task.id, 'Failed')}
                    >
                      <XCircle className="mr-2 size-4" />
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Execution Workspace */}
      <div className="grid min-w-0 gap-6 lg:grid-cols-3">
        {/* Left Column */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* Execution Timeline */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock3 className="size-5" />
                Execution Timeline
              </CardTitle>
            </CardHeader>

            <CardContent>
              {incident ? (
                <ol className="space-y-5">
                  {executionSteps.map((step, index) => (
                    <li key={step.id} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        {step.status === 'completed' ? (
                          <CheckCircle2 className="size-5 text-green-600" />
                        ) : step.status === 'failed' ? (
                          <XCircle className="size-5 text-red-600" />
                        ) : step.status === 'current' ? (
                          <Clock3 className="size-5 text-primary" />
                        ) : (
                          <Circle className="size-5 text-muted-foreground" />
                        )}

                        {index < executionSteps.length - 1 && (
                          <div className="mt-2 min-h-8 w-px flex-1 bg-border" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1 pb-5">
                        <p className="text-sm font-semibold">
                          {step.title}
                          <span className="sr-only">: {stepStatusLabels[step.status]}</span>
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">{step.description}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No execution is available for this agent.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap gap-2">
                {tabs.map((tab) => (
                  <Button
                    key={tab.id}
                    variant={activeTab === tab.id ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.id === 'changes' && <GitCompare className="mr-2 size-4" />}
                    {tab.id === 'logs' && <Terminal className="mr-2 size-4" />}
                    {tab.id === 'tests' && <TestTube2 className="mr-2 size-4" />}
                    {tab.label}
                  </Button>
                ))}
              </div>
            </CardHeader>

            <CardContent className="min-w-0">
              {!incident ? (
                <p className="text-sm text-muted-foreground">
                  Assign an incident to view execution details.
                </p>
              ) : !execution ? (
                <p className="text-sm text-muted-foreground">
                  No execution data yet for {incident.id}.
                </p>
              ) : activeTab === 'changes' ? (
                <div className="space-y-4">
                  <div className="rounded-lg border p-3">
                    <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
                      <FileCode2 className="size-4" />
                      Code Explorer
                    </p>

                    <div className="space-y-2">
                      {execution.files.map((file) => (
                        <div
                          key={file}
                          className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs"
                        >
                          <FileCode2 className="size-4 shrink-0" />
                          <span className="break-all font-mono">{file}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-sm font-semibold">Proposed Diff</p>

                    {hasCompletedStep(executionSteps, 'fix') ? (
                      <div className="overflow-x-auto rounded-lg border bg-slate-950 p-4 font-mono text-xs leading-7">
                        {execution.diff.map((line, index) => (
                          <div
                            key={index}
                            className={
                              line.type === 'added'
                                ? 'whitespace-pre text-green-400'
                                : line.type === 'removed'
                                  ? 'whitespace-pre text-red-400'
                                  : 'whitespace-pre text-slate-300'
                            }
                          >
                            {line.text}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        The agent has not proposed a change yet.
                      </p>
                    )}
                  </div>
                </div>
              ) : activeTab === 'logs' ? (
                visibleLogs && visibleLogs.length > 0 ? (
                  <div className="overflow-x-auto rounded-lg bg-slate-950 p-4">
                    <pre className="font-mono text-xs leading-7 text-green-300">
                      {visibleLogs.map((log) => log.text).join('\n')}
                    </pre>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No log output yet.</p>
                )
              ) : hasCompletedStep(executionSteps, 'tests') ? (
                <div className="space-y-3">
                  {execution.tests.map((test) => (
                    <div
                      key={test.name}
                      className="flex items-center justify-between gap-3 rounded-lg border p-3"
                    >
                      <span className="text-sm">{test.name}</span>

                      {test.passed ? (
                        <Badge
                          variant="outline"
                          className="border-green-200 bg-green-100 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
                        >
                          <CheckCircle2 className="mr-1 size-3" />
                          Passed
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-red-200 bg-red-100 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                        >
                          <XCircle className="mr-1 size-3" />
                          Failed
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Tests have not run yet.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0">
          <Card>
            <CardHeader>
              <CardTitle>Human Review</CardTitle>
            </CardHeader>

            <CardContent className="space-y-4">
              {!reviewTask || !reviewStatus ? (
                <p className="text-sm text-muted-foreground">
                  No proposed changes are awaiting review.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Review the proposed code changes and test results before making a decision.
                  </p>

                  <p className="text-xs text-muted-foreground">
                    {reviewTask.id}
                    {reviewTask.incidentId && ` · ${reviewTask.incidentId}`}
                  </p>

                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Review Status</span>
                    <Badge variant="outline">{reviewStatus}</Badge>
                  </div>

                  <div className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">Validation summary</p>
                    <p className="mt-1 text-muted-foreground">
                      {reviewExecution
                        ? formatTestSummary(reviewExecution.tests)
                        : 'No test results yet.'}
                    </p>
                  </div>

                  {reviewStatus === 'Pending' ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Button onClick={() => updateTaskStatus(reviewTask.id, 'Completed')}>
                        <CheckCircle2 className="mr-2 size-4" />
                        Approve
                      </Button>

                      <Button
                        variant="destructive"
                        onClick={() => updateTaskStatus(reviewTask.id, 'Failed')}
                      >
                        <XCircle className="mr-2 size-4" />
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <p className="text-sm font-medium">Decision: {reviewStatus}</p>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Decisions update the task status. They do not change source code.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
