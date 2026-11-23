import { Link } from 'react-router-dom';

import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@page/design-system/components/ui/card';

import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from '@page/design-system/components/ui/table';

import { Badge } from '@page/design-system/components/ui/badge';

import AgentOverview, {
  type Agent,
} from '../components/agents/AgentOverview';

import { mockIncidents } from '../data/mockIncidents';
import { mockAgents } from '../data/mockAgents';
import { useTasks } from '../context/TaskContext';

const severityColors: Record<string, string> = {
  Critical:
    'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  High:
    'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  Medium:
    'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300',
  Low:
    'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
};

const incidentStatusColors: Record<string, string> = {
  Investigating:
    'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-950 dark:text-purple-300',
  Open:
    'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-300',
  Resolved:
    'bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-300',
  'Awaiting Approval':
    'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-950 dark:text-yellow-300',
};

export default function DashboardPage() {
  const { tasks } = useTasks();

  const totalIncidents = mockIncidents.length;

  const activeIncidents = mockIncidents.filter(
    (incident) => incident.status !== 'Resolved'
  ).length;

  const resolvedIncidents = mockIncidents.filter(
    (incident) => incident.status === 'Resolved'
  ).length;

  const runningAgents = mockAgents.filter(
    (agent) => agent.status === 'Running'
  ).length;

  const queuedTasks = tasks.filter(
    (task) => task.status === 'Queued'
  ).length;

  const runningTasks = tasks.filter(
    (task) => task.status === 'Running'
  ).length;

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
      id: 'active-agents',
      title: 'Running Agents',
      value: runningAgents,
      description: `${runningTasks} tasks running`,
    },
    {
      id: 'queued-tasks',
      title: 'Queued Tasks',
      value: queuedTasks,
      description: `${resolvedIncidents} resolved incidents`,
    },
  ];

  const recentIncidents = mockIncidents.slice(0, 5);

  const agents: Agent[] = mockAgents.map((agent) => {
    const activeTask = tasks.find(
      (task) =>
        task.agentId === agent.id &&
        (task.status === 'Running' ||
          task.status === 'Queued' ||
          task.status === 'Awaiting Approval')
    );

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      task: activeTask?.title ?? 'No active task',
    };
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.id}>
            <CardHeader>
              <CardTitle>{metric.title}</CardTitle>
            </CardHeader>

            <CardContent>
              <div className="text-3xl font-bold">
                {metric.value}
              </div>
              <p className="text-sm text-muted-foreground">
                {metric.description}
              </p>
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
                      className="font-medium text-primary hover:underline"
                    >
                      {incident.id}
                    </Link>
                  </TableCell>

                  <TableCell>{incident.title}</TableCell>

                  <TableCell>
                    <Badge
                      variant="outline"
                      className={severityColors[incident.severity]}
                    >
                      {incident.severity}
                    </Badge>
                  </TableCell>

                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        incidentStatusColors[incident.status]
                      }
                    >
                      {incident.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AgentOverview agents={agents} />
    </div>
  );
}
