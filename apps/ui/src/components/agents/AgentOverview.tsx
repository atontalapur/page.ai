import { Link } from 'react-router-dom';
import type { NodeSummary } from '@page/contracts';
import { Card, CardHeader, CardTitle, CardContent } from '@page/design-system/components/ui/card';

import { agentStatus, byActivity, type AgentStatus } from '../../lib/agents';
import { AgentStatusBadge } from './AgentBadges';

/** What an agent is doing, in a few words. */
function doing(node: NodeSummary): string {
  const [run] = node.current;
  if (run) return `Tier ${run.tier} on ${run.issueTitle}`;
  return node.connected ? 'Waiting for a fix job' : 'Not connected';
}

const tiles: { status: AgentStatus; label: string; className: string; text: string }[] = [
  {
    status: 'running',
    label: 'Running',
    className: 'rounded-md bg-violet-a2',
    text: 'text-violet-11',
  },
  { status: 'idle', label: 'Idle', className: 'rounded-md bg-slate-a2', text: '' },
  {
    status: 'offline',
    label: 'Offline',
    className: 'rounded-md bg-amber-a2',
    text: 'text-amber-11',
  },
];

/** The dashboard's agents card: how many run, idle or are offline, and the busiest three. */
export default function AgentOverview({ agents }: { agents: NodeSummary[] }) {
  const counts = { running: 0, idle: 0, offline: 0 };
  for (const agent of agents) counts[agentStatus(agent)] += 1;
  const busiest = [...agents].sort(byActivity).slice(0, 3);

  return (
    <Card className="w-full min-w-0">
      <CardHeader>
        <CardTitle>Agents</CardTitle>
        <p className="text-sm text-muted-foreground">
          {agents.length} {agents.length === 1 ? 'node daemon' : 'node daemons'}
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          {tiles.map((tile) => (
            <div
              key={tile.status}
              data-testid={`${tile.status}-count`}
              className={`${tile.className} p-3 text-center`}
            >
              <p className={`text-2xl font-bold ${tile.text}`}>{counts[tile.status]}</p>
              <p className={`text-xs sm:text-sm ${tile.text || 'text-muted-foreground'}`}>
                {tile.label}
              </p>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Most active</h3>
          {busiest.length === 0 && (
            <p className="text-sm text-muted-foreground">No node daemon has connected yet.</p>
          )}
          {busiest.map((agent) => (
            <div
              key={agent.name}
              className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <Link
                  to={`/agents/${encodeURIComponent(agent.name)}`}
                  className="font-medium hover:underline"
                >
                  {agent.name}
                </Link>
                <p className="truncate text-sm text-muted-foreground">{doing(agent)}</p>
              </div>
              <AgentStatusBadge status={agentStatus(agent)} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
