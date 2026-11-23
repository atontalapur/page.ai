import { Link } from 'react-router-dom';

import { Card, CardHeader, CardTitle, CardContent } from '@page/design-system/components/ui/card';

import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from '@page/design-system/components/ui/table';

import AgentOverview, { type Agent } from '../components/agents/AgentOverview';
import { SeverityBadge, StatusBadge } from '../components/issues/IssueBadges';
import TokenPrompt from '../components/issues/TokenPrompt';

import { mockAgents } from '../data/mockAgents';
import { getActiveTask, getAgentStatus } from '../data/mockTasks';
import { useIssues } from '../context/IssuesContext';
import { useTasks } from '../context/TaskContext';
import { isOpen, shortId } from '../lib/issueLabels';

export default function DashboardPage() {
  const { tasks } = useTasks();
  const { issues } = useIssues();

  const totalIncidents = issues.length;

  const activeIncidents = issues.filter(isOpen).length;

  const runningAgents = mockAgents.filter(
    (agent) => getAgentStatus(agent, tasks) === 'Running',
  ).length;

  const queuedTasks = tasks.filter((task) => task.status === 'Queued').length;

  const runningTasks = tasks.filter((task) => task.status === 'Running').length;

  const metrics = [
    {
      id: 'total-incidents',
      title: 'Total Incidents',
      value: totalIncidents,
      description: 'Total reported incidents',
    },
    {
      id: 'active-incidents',
      title: 'Active Incidents',
      value: activeIncidents,
      description: 'Needs attention',
    },
    {
      id: 'running-agents',
      title: 'Running Agents',
      value: runningAgents,
      description: `${runningTasks} ${runningTasks === 1 ? 'task' : 'tasks'} running`,
    },
    {
      id: 'queued-tasks',
      title: 'Queued Tasks',
      value: queuedTasks,
      description: `${tasks.length} total ${tasks.length === 1 ? 'task' : 'tasks'}`,
    },
  ];

  // The store keeps issues most recently updated first.
  const recentIncidents = issues.slice(0, 5);

  const agents: Agent[] = mockAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: getAgentStatus(agent, tasks),
    task: getActiveTask(tasks, agent.id)?.title ?? 'No active task',
  }));

  return (
    <div className="space-y-6">
      <TokenPrompt />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.id}>
            <CardHeader>
              <CardTitle>{metric.title}</CardTitle>
            </CardHeader>

            <CardContent>
              <div className="text-3xl font-bold">{metric.value}</div>
              <p className="text-sm text-muted-foreground">{metric.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Incidents</CardTitle>
        </CardHeader>

        <CardContent className="overflow-x-auto">
          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Incident</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {recentIncidents.map((incident) => (
                <TableRow key={incident.id}>
                  <TableCell>
                    <Link
                      to={`/incidents/${incident.id}`}
                      className="font-mono font-medium text-primary hover:underline"
                    >
                      {shortId(incident.id)}
                    </Link>
                  </TableCell>

                  <TableCell>{incident.title}</TableCell>

                  <TableCell>
                    <SeverityBadge severity={incident.severity} />
                  </TableCell>

                  <TableCell>
                    <StatusBadge status={incident.status} />
                  </TableCell>
                </TableRow>
              ))}

              {recentIncidents.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    No incidents yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AgentOverview agents={agents} />
    </div>
  );
}
