import { useEffect, useState } from 'react';
import type { Issue, IssueDecision } from '@page/contracts';

import { loadDecisions } from '../../live/decisions';

const QUESTION: Record<IssueDecision['question'], string> = {
  triage: 'Triage',
  start_tier: 'Starting tier',
  escalation: 'Escalation',
};

function answer(d: IssueDecision): string {
  if (d.question === 'start_tier') return `Tier ${d.choice}`;
  if (d.question === 'escalation') {
    return (
      { retry: 'Retry this tier', escalate: 'Move up a tier', page: 'Page a person' }[d.choice] ??
      d.choice
    );
  }
  return d.choice;
}

/** jev's calls on the issue: what it chose, and how sure it was. */
export default function DecisionsPanel({ issue }: { issue: Issue }) {
  const [decisions, setDecisions] = useState<IssueDecision[] | undefined>();

  useEffect(() => {
    let live = true;
    loadDecisions(issue.id).then(
      (d) => live && setDecisions(d),
      () => live && setDecisions([]),
    );
    return () => {
      live = false;
    };
  }, [issue.id, issue.updatedAt]);

  if (decisions === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (decisions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No model decisions yet. The rules decided everything so far.
      </p>
    );
  }
  return (
    <ol className="space-y-3">
      {decisions.map((d) => (
        <li key={d.id} className="space-y-1 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{QUESTION[d.question]}</span>
            <span className="font-medium">{answer(d)}</span>
          </div>
          <div
            className="h-1 overflow-hidden rounded-full bg-slate-a3"
            role="meter"
            aria-label={`${QUESTION[d.question]} confidence`}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={d.confidence}
          >
            <div
              className="h-full bg-violet-9"
              style={{ width: `${Math.round(d.confidence * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {Math.round(d.confidence * 100)}% sure · {d.model}
          </p>
        </li>
      ))}
    </ol>
  );
}
