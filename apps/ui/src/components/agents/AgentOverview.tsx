import { Card, CardHeader, CardTitle, CardContent } from '@page/design-system/components/ui/card';
import { Badge } from '@page/design-system/components/ui/badge';

export type Agent = {
  id: string;
  name: string;
  status: 'Running' | 'Idle' | 'Failed';
  task: string;
};

type AgentOverviewProps = {
  agents: Agent[];
};

const statusColors: Record<Agent['status'], string> = {
  Running: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-950 dark:text-green-300',
  Idle: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300',
  Failed: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300',
};

export default function AgentOverview({ agents }: AgentOverviewProps) {
  const counts = agents.reduce<Record<Agent['status'], number>>(
    (acc, agent) => {
      acc[agent.status]++;
      return acc;
    },
    { Running: 0, Idle: 0, Failed: 0 },
  );

  const runningAgents = counts.Running;
  const idleAgents = counts.Idle;
  const failedAgents = counts.Failed;

  return (
    <Card className="w-full min-w-0">
      <CardHeader>
        <CardTitle>AI Agents</CardTitle>
        <p className="text-sm text-muted-foreground">{agents.length} Total Agents</p>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <div
            data-testid="running-count"
            className="rounded-lg border border-green-200 bg-green-50 p-3 text-center dark:border-green-900 dark:bg-green-950/40"
          >
            <p className="text-2xl font-bold text-green-700 dark:text-green-400">{runningAgents}</p>
            <p className="text-xs text-green-700 dark:text-green-300 sm:text-sm">Running</p>
          </div>

          <div data-testid="idle-count" className="rounded-lg border bg-muted/50 p-3 text-center">
            <p className="text-2xl font-bold">{idleAgents}</p>
            <p className="text-xs text-muted-foreground sm:text-sm">Idle</p>
          </div>

          <div
            data-testid="failed-count"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-center dark:border-red-900 dark:bg-red-950/40"
          >
            <p className="text-2xl font-bold text-red-700 dark:text-red-400">{failedAgents}</p>
            <p className="text-xs text-red-700 dark:text-red-300 sm:text-sm">Failed</p>
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Recently Active Agents</h3>

          {agents.slice(0, 3).map((agent) => (
            <div
              key={agent.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{agent.name}</p>
                <p className="text-sm text-muted-foreground">{agent.task}</p>
              </div>

              <Badge variant="outline" className={statusColors[agent.status]}>
                {agent.status}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
