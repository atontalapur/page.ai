import type { NodeRun, Run, Step } from '@page/contracts';
import { Badge } from '@page/design-system/components/ui/badge';

import { agentStatusLabels, type AgentStatus } from '../../lib/agents';
import { runStatusLabels } from '../../lib/issueLabels';
import { commandLabel, editOf, shortPath, stepResult, type StepTone } from '../../lib/runSteps';
import { agentStatusStyles, runStatusStyles } from '../../lib/statusStyles';

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return (
    <Badge variant="outline" className={agentStatusStyles[status]}>
      {agentStatusLabels[status]}
    </Badge>
  );
}

export function RunStatusBadge({ status }: { status: Run['status'] }) {
  return (
    <Badge variant="outline" className={runStatusStyles[status]}>
      {runStatusLabels[status]}
    </Badge>
  );
}

const toneText: Record<StepTone, string> = {
  ok: 'text-green-11',
  bad: 'text-red-11',
  refused: 'text-amber-11',
  running: 'text-violet-11',
};

/** What a step did, the way the incident page names it: `Read products.ts`, `$ ls`. */
function stepName(step: Step): string {
  const edit = editOf(step);
  if (edit) return `Edit ${shortPath(edit.path)}`;
  const named = commandLabel(step.input);
  return named ? `${named.verb} ${named.target}` : `$ ${step.input}`;
}

/** The step a run is on, with its result, on one line. */
export function LastStep({ run }: { run: NodeRun }) {
  if (!run.lastStep) {
    return <p className="text-sm text-muted-foreground">No steps yet</p>;
  }
  const { label, tone } = stepResult(run.lastStep, run.status === 'running');
  return (
    <p className="flex min-w-0 items-center gap-2 text-sm">
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {run.lastStep.seq}
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={run.lastStep.input}>
        {stepName(run.lastStep)}
      </code>
      <span className={`shrink-0 text-xs font-medium ${toneText[tone]}`}>{label}</span>
    </p>
  );
}
