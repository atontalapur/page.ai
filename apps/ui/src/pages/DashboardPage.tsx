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

import AgentOverview from '../components/agents/AgentOverview';
import { SeverityBadge, StatusBadge } from '../components/issues/IssueBadges';
import TokenPrompt from '../components/issues/TokenPrompt';

import { useAgents, useIssues } from '../context/IssuesContext';
import { agentStatus } from '../lib/agents';
import { awaitsReview } from '../components/issues/ReviewActions';
import { isOpen, shortId } from '../lib/issueLabels';
import { useSpend } from '../live/stats';

export default function DashboardPage() {
  const { issues } = useIssues();
  const { nodes } = useAgents();

  const totalIncidents = issues.length;

  const activeIncidents = issues.filter(isOpen).length;

  const runningAgents = nodes.filter((node) => agentStatus(node) === 'running').length;

  const connectedAgents = nodes.filter((node) => node.connected).length;

  const fixing = issues.filter((issue) => issue.status === 'fixing').length;

  const awaiting = issues.filter(awaitsReview).length;

  // Reloaded whenever an issue changes, which is when a run or a decision may have cost.
  const spend = useSpend(issues[0]?.updatedAt ?? '');

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
      description: `${connectedAgents} of ${nodes.length} connected`,
    },
    {
      id: 'fixes-in-progress',
      title: 'Fixes in Progress',
      value: fixing,
      description: `${awaiting} awaiting review`,
    },
    {
      id: 'model-spend',
      title: 'Model Spend',
      value: spend ? `$${spend.totalUsd.toFixed(2)}` : '…',
      description: spend
        ? `${spend.runs} runs · ${spend.decisions} decisions, all sessions`
        : 'Across all sessions',
    },
  ];

  // The store keeps issues most recently updated first.
  const recentIncidents = issues.slice(0, 5);

  return (
    <div className="space-y-6">
      <TokenPrompt />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        {metrics.map((metric) => (
          <Card key={metric.id}>
            <CardHeader>
              <CardTitle>{metric.title}</CardTitle>
            </CardHeader>

            <CardContent>
              <div className="text-3xl font-bold tabular-nums">{metric.value}</div>
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

      <AgentOverview agents={nodes} />
    </div>
  );
}
