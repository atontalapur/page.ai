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

const recentIncidents = [
  {
    id: 'INC-001',
    title: 'Database connection timeout',
    severity: 'Critical',
    status: 'Investigating',
  },
  {
    id: 'INC-002',
    title: 'API response latency',
    severity: 'Medium',
    status: 'Open',
  },
];

const agents: Agent[] = [
  {
    id: 'AG-001',
    name: 'Diagnostic Agent',
    status: 'Running',
    task: 'Analyzing database timeout',
  },
  {
    id: 'AG-002',
    name: 'Fix Agent',
    status: 'Running',
    task: 'Generating patch for API failure',
  },
  {
    id: 'AG-003',
    name: 'Review Agent',
    status: 'Idle',
    task: 'Waiting for approval',
  },
  {
    id: 'AG-004',
    name: 'Monitoring Agent',
    status: 'Failed',
    task: 'Connection lost',
  },
];

const runningAgents = agents.filter((agent) => agent.status === 'Running').length;

const metrics = [
  {
    id: 'total-incidents',
    title: 'Total Incidents',
    value: 24,
    description: '+3 today',
  },
  {
    id: 'active-incidents',
    title: 'Active Incidents',
    value: 8,
    description: 'Needs attention',
  },
  {
    id: 'active-agents',
    title: 'Active Agents',
    value: agents.length,
    description: `${runningAgents} tasks running`,
  },
  {
    id: 'resolved-today',
    title: 'Resolved Today',
    value: 12,
    description: 'Resolved in the last 24 hours',
  },
];

const severityColors: Record<string, string> = {
  Critical: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  High: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  Medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300',
  Low: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
};

const incidentStatusColors: Record<string, string> = {
  Investigating:
    'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-950 dark:text-purple-300',
  Open: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-300',
  Resolved: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-300',
};

export default function DashboardPage() {
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
        <CardContent>
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
              {recentIncidents.map((Incident) => (
                <TableRow key={Incident.id}>
                  <TableCell>{Incident.id}</TableCell>
                  <TableCell>{Incident.title}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={severityColors[Incident.severity]}>
                      {Incident.severity}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={incidentStatusColors[Incident.status]}>
                      {Incident.status}
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
