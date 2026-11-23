import { useEffect, useState } from 'react';
import type { Issue, IssueRun, Step } from '@page/contracts';
import { Badge } from '@page/design-system/components/ui/badge';

import { useIssues } from '../../context/IssuesContext';
import { runStatusLabels, shortId } from '../../lib/issueLabels';
import { runStatusStyles } from '../../lib/statusStyles';

// Steps reach the database as the agent works but send no event, so a fixing issue's runs
// are reloaded on this interval as well as on every issue change.
export const RUNS_POLL_MS = 5_000;

function stepResult(step: Step): { label: string; failed: boolean } {
  if (!step.allowed) return { label: 'Refused', failed: true };
  if (step.exitCode === null) return { label: 'Timed out', failed: true };
  if (step.exitCode === 0) return { label: 'OK', failed: false };
  return { label: `Exit ${step.exitCode}`, failed: true };
}

// A thought longer than this shows its start, with the rest behind a toggle.
const THOUGHT_PREVIEW_CHARS = 280;

function Thought({ text }: { text: string }) {
  const style = 'whitespace-pre-wrap break-words text-sm text-muted-foreground';
  if (text.length <= THOUGHT_PREVIEW_CHARS) return <p className={style}>{text}</p>;
  return (
    <details>
      <summary className={`cursor-pointer ${style}`}>
        {text.slice(0, THOUGHT_PREVIEW_CHARS).trimEnd()}...
      </summary>
      <p className={style}>{text.slice(THOUGHT_PREVIEW_CHARS).trimStart()}</p>
    </details>
  );
}

const time = (at: string | null) => (at ? new Date(at).toLocaleTimeString() : undefined);

function StepRow({ step }: { step: Step }) {
  const { label, failed } = stepResult(step);
  return (
    <li className="space-y-1 border-b py-2 last:border-b-0">
      {step.thought && <Thought text={step.thought} />}
      <div className="flex items-start justify-between gap-3">
        <code className="min-w-0 break-words font-mono text-xs">
          <span className="text-muted-foreground">
            {step.seq} {step.kind === 'exec' ? '$' : step.kind}{' '}
          </span>
          {step.input}
        </code>
        <span
          className={`shrink-0 text-xs ${failed ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground'}`}
        >
          {label}
        </span>
      </div>
      {step.outputTrimmed !== '' && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Output</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-words">
            {step.outputTrimmed}
          </pre>
        </details>
      )}
    </li>
  );
}

function RunCard({ run, open }: { run: IssueRun; open: boolean }) {
  const started = time(run.startedAt);
  const finished = time(run.finishedAt);
  return (
    <details open={open} className="rounded-lg border p-3">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Tier {run.tier}</span>
        <Badge variant="outline" className={runStatusStyles[run.status]}>
          {runStatusLabels[run.status]}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">{shortId(run.id)}</span>
        <span className="text-xs text-muted-foreground">
          {run.steps.length} {run.steps.length === 1 ? 'step' : 'steps'}
          {started && ` · started ${started}`}
          {finished && ` · finished ${finished}`}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {run.prUrl && (
          <a href={run.prUrl} target="_blank" rel="noreferrer" className="text-sm underline">
            Pull request
          </a>
        )}
        {run.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No steps yet.</p>
        ) : (
          <ol aria-label={`Tier ${run.tier} steps`}>
            {run.steps.map((step) => (
              <StepRow key={step.seq} step={step} />
            ))}
          </ol>
        )}
        {run.diff && (
          <details open>
            <summary className="cursor-pointer text-sm font-medium">Patch</summary>
            <pre className="mt-1 max-h-96 overflow-auto rounded bg-muted p-2 text-xs">
              {run.diff}
            </pre>
          </details>
        )}
      </div>
    </details>
  );
}

/** The agent's runs on `issue`, newest open, kept current while it is fixing. */
export default function RunsPanel({ issue }: { issue: Issue }) {
  const { fetchRuns } = useIssues();
  const [runs, setRuns] = useState<IssueRun[] | undefined>();
  const [failed, setFailed] = useState(false);
  const fixing = issue.status === 'fixing';

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void fetchRuns(issue.id).then((loaded) => {
        if (cancelled) return;
        if (loaded) setRuns(loaded);
        setFailed(loaded === undefined);
      });
    load();
    const timer = fixing ? setInterval(load, RUNS_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchRuns, issue.id, issue.updatedAt, fixing]);

  if (runs === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        {failed ? 'Could not load the runs.' : 'Loading runs...'}
      </p>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No agent has worked on this incident yet.</p>
    );
  }
  return (
    <div className="space-y-3">
      {runs.map((run, i) => (
        <RunCard key={run.id} run={run} open={i === runs.length - 1} />
      ))}
    </div>
  );
}
