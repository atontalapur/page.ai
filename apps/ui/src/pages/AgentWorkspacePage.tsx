import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AddCircleIcon,
  AltArrowLeftIcon,
  BotIcon,
  HistoryIcon,
  PulseIcon,
} from '@solar-icons/react/line-duotone';
import type { NodeRun, NodeSummary } from '@page/contracts';

import { Button } from '@page/design-system/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@page/design-system/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@page/design-system/components/ui/table';

import { AgentStatusBadge, LastStep, RunStatusBadge } from '../components/agents/AgentBadges';
import StartFixDialog from '../components/agents/StartFixDialog';
import StopRunButton from '../components/agents/StopRunButton';
import { RunHeading, RunReview } from '../components/issues/RunsPanel';
import TokenPrompt from '../components/issues/TokenPrompt';
import { useAgents, useIssues } from '../context/IssuesContext';
import { agentStatus, lastRunLine, presence } from '../lib/agents';
import { shortId } from '../lib/issueLabels';
import { useIssueRuns, useNodeRuns } from '../live/useLiveRuns';

function BackLink() {
  return (
    <Link
      to="/agents"
      className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <AltArrowLeftIcon className="size-4" />
      Back to Agents
    </Link>
  );
}

function IssueLink({ run }: { run: NodeRun }) {
  return (
    <Link to={`/incidents/${run.issueId}`} className="min-w-0 text-primary hover:underline">
      <span className="font-mono">{shortId(run.issueId)}</span> {run.issueTitle}
    </Link>
  );
}

/**
 * The run the agent holds, with every step so far. The steps come from the issue's runs and
 * arrive as the daemon sends them.
 */
function CurrentRun({ run }: { run: NodeRun }) {
  const { getIssue } = useIssues();
  const { runs, failed } = useIssueRuns(run.issueId, getIssue(run.issueId)?.updatedAt);
  const full = runs?.find((r) => r.id === run.id);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold">
          <IssueLink run={run} />
        </p>
        <StopRunButton issueId={run.issueId} />
      </div>
      <RunHeading run={full ?? run} />
      {full ? (
        <RunReview run={full} />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {runs === undefined && !failed ? 'Loading the run...' : 'Could not load its steps.'}
          </p>
          <LastStep run={run} />
        </div>
      )}
    </div>
  );
}

const clock = (at: string | null) => (at ? new Date(at).toLocaleString() : 'Not started');

/** The runs the agent worked, the newest first, kept current as they progress. */
function RecentRuns({ node }: { node: NodeSummary }) {
  // A new run moves lastRunAt, which loads the list again; steps and results arrive as events.
  const { runs, failed } = useNodeRuns(node.name, node.lastRunAt ?? '');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HistoryIcon className="size-5" />
          Recent runs
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {runs === undefined ? (
          <p className="text-sm text-muted-foreground">
            {failed ? 'Could not load the runs.' : 'Loading runs...'}
          </p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">This agent has not worked a run yet.</p>
        ) : (
          <Table className="min-w-[640px]" aria-label="Recent runs">
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Incident</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Steps</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-mono text-xs">{shortId(run.id)}</TableCell>
                  <TableCell className="max-w-80 truncate">
                    <IssueLink run={run} />
                  </TableCell>
                  <TableCell>Tier {run.tier}</TableCell>
                  <TableCell>
                    <RunStatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="text-xs">{clock(run.startedAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.stepCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** One node daemon: its connection, the run it is on with its steps live, and its history. */
export default function AgentWorkspacePage() {
  const { id = '' } = useParams<{ id: string }>();
  const { getNode, loaded } = useAgents();
  const { status } = useIssues();
  const node = getNode(id);
  const [startOpen, setStartOpen] = useState(false);

  if (!node) {
    return (
      <div className="space-y-4">
        <BackLink />
        <TokenPrompt />
        {!loaded ? (
          status !== 'needs_token' && <p className="text-muted-foreground">Loading agent...</p>
        ) : (
          <>
            <h2 className="text-2xl font-bold">Agent not found</h2>
            <p className="text-sm text-muted-foreground">
              No node daemon called {id} has connected or worked a run.
            </p>
          </>
        )}
      </div>
    );
  }

  const [current] = node.current;
  const summary = [
    { label: 'Connection', value: presence(node) },
    { label: 'Last run', value: lastRunLine(node) },
  ];

  return (
    <div className="min-w-0 space-y-6">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <BotIcon className="size-6 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="break-all text-2xl font-bold tracking-tight">{node.name}</h2>
            <p className="text-sm text-muted-foreground">Node daemon</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <AgentStatusBadge status={agentStatus(node)} />
          {node.connected && (
            <Button onClick={() => setStartOpen(true)}>
              <AddCircleIcon className="size-4" />
              Start a fix here
            </Button>
          )}
        </div>
      </div>
      <StartFixDialog open={startOpen} onClose={() => setStartOpen(false)} agent={node.name} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {summary.map((item) => (
          <Card key={item.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{item.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm font-semibold">{item.value}</p>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Current incident</CardTitle>
          </CardHeader>
          <CardContent>
            {current ? (
              <p className="truncate text-sm font-semibold">
                <IssueLink run={current} />
              </p>
            ) : (
              <p className="text-sm font-semibold">None</p>
            )}
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="current-run-heading" className="min-w-0 space-y-3">
        <h3 id="current-run-heading" className="flex items-center gap-2 text-base font-semibold">
          <PulseIcon className="size-5" />
          Current run
        </h3>
        {node.current.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {node.connected
              ? 'No run in progress. The agent claims the next fix job that is queued.'
              : 'The agent is offline, so it is not running anything.'}
          </p>
        ) : (
          node.current.map((run) => <CurrentRun key={run.id} run={run} />)
        )}
      </section>

      <RecentRuns node={node} />
    </div>
  );
}
