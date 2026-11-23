import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  Search,
  Plus,
} from 'lucide-react';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@page/design-system/components/ui/card';
import { Badge } from '@page/design-system/components/ui/badge';
import { Input } from '@page/design-system/components/ui/input';
import { Button } from '@page/design-system/components/ui/button';

import AssignTaskDialog from '../components/agents/AssignTaskDialog';

import {
  mockAgents,
  type AgentStatus,
} from '../data/mockAgents';

const statusStyles: Record<AgentStatus, string> = {
  Running: 'border-green-200 bg-green-100 text-green-700',
  Idle: 'border-gray-200 bg-gray-100 text-gray-700',
  Failed: 'border-red-200 bg-red-100 text-red-700',
};

export default function AgentsPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);

  const filteredAgents = useMemo(() => {
    return mockAgents.filter((agent) => {
      const matchesSearch =
        agent.name.toLowerCase().includes(search.toLowerCase()) ||
        agent.id.toLowerCase().includes(search.toLowerCase()) ||
        agent.type.toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        statusFilter === 'All' || agent.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [search, statusFilter]);

  const running = mockAgents.filter(
    (agent) => agent.status === 'Running'
  ).length;

  const idle = mockAgents.filter(
    (agent) => agent.status === 'Idle'
  ).length;

  const failed = mockAgents.filter(
    (agent) => agent.status === 'Failed'
  ).length;

  const metrics = [
    { label: 'Total Agents', value: mockAgents.length, icon: Bot },
    { label: 'Running', value: running, icon: Activity },
    { label: 'Idle', value: idle, icon: CheckCircle2 },
    { label: 'Failed', value: failed, icon: CircleAlert },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            Agents
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Monitor AI agents and their current investigations.
          </p>
        </div>

        <Button onClick={() => setAssignDialogOpen(true)}>
          <Plus className="mr-2 size-4" />
          Assign Task
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">
                {metric.label}
              </CardTitle>
              <metric.icon className="size-4 text-muted-foreground" />
            </CardHeader>

            <CardContent>
              <p className="text-3xl font-bold">
                {metric.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search agents..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
          />
        </div>

        <select
          aria-label="Filter agents by status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="All">All Statuses</option>
          <option value="Running">Running</option>
          <option value="Idle">Idle</option>
          <option value="Failed">Failed</option>
        </select>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredAgents.map((agent) => (
          <Card key={agent.id} className="flex flex-col">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Bot className="size-5 text-primary" />
                  </div>

                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">
                      {agent.name}
                    </CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {agent.id} · {agent.type}
                    </p>
                  </div>
                </div>

                <Badge
                  variant="outline"
                  className={statusStyles[agent.status]}
                >
                  {agent.status}
                </Badge>
              </div>
            </CardHeader>

            <CardContent className="flex flex-1 flex-col gap-5">
              <p className="text-sm text-muted-foreground">
                {agent.description}
              </p>

              <div className="grid grid-cols-2 gap-4 rounded-lg bg-muted/50 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    Tasks Completed
                  </p>
                  <p className="mt-1 text-lg font-semibold">
                    {agent.tasksCompleted}
                  </p>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground">
                    Current Incident
                  </p>

                  {agent.currentIncident ? (
                    <Link
                      to={`/incidents/${agent.currentIncident}`}
                      className="mt-1 block text-sm font-semibold text-primary hover:underline"
                    >
                      {agent.currentIncident}
                    </Link>
                  ) : (
                    <p className="mt-1 text-sm font-semibold">
                      None
                    </p>
                  )}
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Last active:{' '}
                {new Date(agent.lastActive).toLocaleString()}
              </p>

              <Link
                to={`/agents/${agent.id}`}
                className="mt-auto flex h-9 w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                View Workspace
              </Link>
            </CardContent>
          </Card>
        ))}

        {filteredAgents.length === 0 && (
          <div className="col-span-full rounded-lg border p-10 text-center text-sm text-muted-foreground">
            No agents match your search or filters.
          </div>
        )}
      </div>

      <AssignTaskDialog
        open={assignDialogOpen}
        onClose={() => setAssignDialogOpen(false)}
      />
    </div>
  );
}

