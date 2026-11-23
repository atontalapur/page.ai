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

import { Badge } from '@page/design-system/components/ui/badge';

import AgentOverview, { type Agent } from '../components/agents/AgentOverview';

import { mockIncidents } from '../data/mockIncidents';
import { mockAgents } from '../data/mockAgents';
import { useTasks } from '../context/TaskContext';
import { incidentStatusStyles, severityStyles } from '../lib/statusStyles';

export default function DashboardPage() {
  const { tasks } = useTasks();

  const totalIncidents = mockIncidents.length;

  const activeIncidents = mockIncidents.filter((incident) => incident.status !== 'Resolved').length;

  const runningAgents = mockAgents.filter((agent) => agent.status === 'Running').length;

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

  const recentIncidents = [...mockIncidents]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5);

  const agents: Agent[] = mockAgents.map((agent) => {
    const activeTask = tasks.find(
      (task) =>
        task.agentId === agent.id &&
        (task.status === 'Running' ||
          task.status === 'Queued' ||
          task.status === 'Awaiting Approval'),
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
                      className="font-medium text-primary hover:underline"
                    >
                      {incident.id}
                    </Link>
                  </TableCell>

                  <TableCell>{incident.title}</TableCell>

                  <TableCell>
                    <Badge variant="outline" className={severityStyles[incident.severity]}>
                      {incident.severity}
                    </Badge>
                  </TableCell>

                  <TableCell>
                    <Badge variant="outline" className={incidentStatusStyles[incident.status]}>
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
