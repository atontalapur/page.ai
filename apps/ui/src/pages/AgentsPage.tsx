import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AddCircleIcon,
  BotIcon,
  CloudCrossIcon,
  MagnifierIcon,
  PulseIcon,
  SleepingIcon,
} from '@solar-icons/react/linear';
import type { NodeSummary } from '@page/contracts';

import { Card, CardContent, CardHeader, CardTitle } from '@page/design-system/components/ui/card';
import { Input } from '@page/design-system/components/ui/input';
import { Button } from '@page/design-system/components/ui/button';

import { AgentStatusBadge, LastStep, RunStatusBadge } from '../components/agents/AgentBadges';
import StartFixDialog from '../components/agents/StartFixDialog';
import TokenPrompt from '../components/issues/TokenPrompt';
import { useAgents, useIssues } from '../context/IssuesContext';
import {
  AGENT_STATUSES,
  agentStatus,
  agentStatusLabels,
  byActivity,
  lastRunLine,
  presence,
  type AgentStatus,
} from '../lib/agents';
import { shortId } from '../lib/issueLabels';

function AgentCard({ agent }: { agent: NodeSummary }) {
  const status = agentStatus(agent);
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <BotIcon className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <CardTitle className="truncate text-base">{agent.name}</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">{presence(agent)}</p>
            </div>
          </div>
          <AgentStatusBadge status={status} />
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        {agent.current.length === 0 ? (
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-sm font-medium">No run in progress</p>
            <p className="mt-1 text-xs text-muted-foreground">{lastRunLine(agent)}</p>
          </div>
        ) : (
          agent.current.map((run) => (
            <div key={run.id} className="space-y-2 rounded-lg bg-muted/50 p-3">
              <Link
                to={`/incidents/${run.issueId}`}
                className="block min-w-0 text-sm font-semibold text-primary hover:underline"
              >
                <span className="font-mono">{shortId(run.issueId)}</span>{' '}
                <span className="truncate">{run.issueTitle}</span>
              </Link>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold">Tier {run.tier}</span>
                <RunStatusBadge status={run.status} />
                <span className="text-muted-foreground">
                  {run.stepCount} {run.stepCount === 1 ? 'step' : 'steps'}
                </span>
              </div>
              <LastStep run={run} />
            </div>
          ))
        )}

        <Link
          to={`/agents/${encodeURIComponent(agent.name)}`}
          className="mt-auto flex h-9 w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          View agent
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * The node daemons that run fix jobs, live: each one's connection, the run it is on and its
 * last step. A daemon shows here once it has connected, or once it has worked a run.
 */
export default function AgentsPage() {
  const { nodes, loaded } = useAgents();
  const { status: feed } = useIssues();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<AgentStatus | 'all'>('all');
  const [startOpen, setStartOpen] = useState(false);

  const agents = useMemo(() => [...nodes].sort(byActivity), [nodes]);
  const shown = agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(search.trim().toLowerCase()) &&
      (statusFilter === 'all' || agentStatus(agent) === statusFilter),
  );
  const count = (status: AgentStatus) => agents.filter((a) => agentStatus(a) === status).length;

  const metrics = [
    { label: 'Agents', value: agents.length, icon: BotIcon },
    { label: 'Running', value: count('running'), icon: PulseIcon },
    { label: 'Idle', value: count('idle'), icon: SleepingIcon },
    { label: 'Offline', value: count('offline'), icon: CloudCrossIcon },
  ];

  return (
    <div className="space-y-6">
      <TokenPrompt />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Agents</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Node daemons that claim fix jobs and run them, live.
          </p>
        </div>

        <Button onClick={() => setStartOpen(true)}>
          <AddCircleIcon className="mr-2 size-4" />
          Start a fix
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
              <metric.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{metric.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <MagnifierIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
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
          onChange={(event) => setStatusFilter(event.target.value as AgentStatus | 'all')}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="all">All statuses</option>
          {AGENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {agentStatusLabels[status]}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((agent) => (
          <AgentCard key={agent.name} agent={agent} />
        ))}

        {shown.length === 0 && (
          <div className="col-span-full rounded-lg border p-10 text-center text-sm text-muted-foreground">
            {!loaded
              ? feed === 'needs_token'
                ? 'Connect to the orchestrator to see its agents.'
                : 'Loading agents...'
              : agents.length === 0
                ? 'No node daemon has connected yet. Start one with pnpm --filter @page/node start.'
                : 'No agents match your search or filters.'}
          </div>
        )}
      </div>

      <StartFixDialog open={startOpen} onClose={() => setStartOpen(false)} />
    </div>
  );
}
